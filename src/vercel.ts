import { redactSecrets } from "./redact.js";
import type { MonitorConfig, RuntimeLog } from "./types.js";

const API = "https://api.vercel.com";
const REQUEST_TIMEOUT_MS = 20_000;
const STREAM_TIMEOUT_MS = 12_000;
const STREAM_IDLE_MS = 5_000;
const LOG_LIMIT = 1000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

class SafeVercelError extends Error {}

export async function getLatestProductionDeployment(config: MonitorConfig, fetcher: typeof fetch = fetch) {
  const url = new URL("/v6/deployments", API);
  url.searchParams.set("projectId", config.vercelProjectId);
  url.searchParams.set("teamId", config.vercelTeamId);
  url.searchParams.set("target", "production");
  url.searchParams.set("limit", "1");
  const value = await vercelJson(url, config.vercelToken, fetcher) as { deployments?: Array<{ uid?: string; id?: string; target?: string; state?: string; readyState?: string }> };
  const deployment = value.deployments?.find((item) => item.target === "production") ?? value.deployments?.[0];
  const id = deployment?.uid ?? deployment?.id;
  if (!id) throw new Error("Vercel returned no production deployment.");
  return id;
}

export async function getRuntimeLogs(input: {
  config: MonitorConfig;
  deploymentId: string;
  since: number;
  until: number;
  fetcher?: typeof fetch;
}) {
  // The deployment runtime-logs REST endpoint is a live stream. Historical
  // queries use the finite, paginated endpoint used by Vercel CLI logs-v2.
  const url = new URL("https://vercel.com/api/logs/request-logs");
  url.searchParams.set("projectId", input.config.vercelProjectId);
  url.searchParams.set("ownerId", input.config.vercelTeamId);
  url.searchParams.set("deploymentId", input.deploymentId);
  url.searchParams.set("environment", "production");
  url.searchParams.set("startDate", String(input.since));
  url.searchParams.set("endDate", String(input.until));
  return withDeadline("Vercel runtime logs request", async (controller) => {
    const logs: RuntimeLog[] = [];
    for (let page = 0; page < LOG_LIMIT; page++) {
      url.searchParams.set("page", String(page));
      const text = await readResponse(url, input.config.vercelToken, input.fetcher ?? fetch, controller, "Vercel runtime logs request", LOG_LIMIT - logs.length);
      const value = tryJson(text);
      const batch = parseRuntimeLogs(text, input.deploymentId, true);
      logs.push(...batch);
      const hasMore = isRecord(value) && value.hasMoreRows === true;
      if (logs.length > LOG_LIMIT) throw new SafeVercelError("Vercel runtime logs response exceeded the safe historical query limit.");
      if (!hasMore) return logs.filter((log) => log.timestamp >= input.since && log.timestamp <= input.until);
      // Do not advance the state cursor after an incomplete historical window.
      if (logs.length >= LOG_LIMIT || batch.length === 0) throw new SafeVercelError("Vercel runtime logs response exceeded the safe historical query limit.");
    }
    throw new SafeVercelError("Vercel runtime logs response exceeded the safe historical query limit.");
  });
}

export function parseRuntimeLogs(text: string, deploymentId: string, strict = false): RuntimeLog[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parsed = tryJson(trimmed);
  const records = parsed === undefined
    ? trimmed.split("\n").map((line) => line.replace(/^data:\s*/, "").trim()).filter((line) => line && line !== "[DONE]").map(tryJson)
    : [parsed];
  const logs: RuntimeLog[] = [];
  for (const record of records) {
    for (const value of logValues(record)) {
      const log = isRecord(value) ? normalizeLog(value, deploymentId) : null;
      if (log) logs.push(log);
      else if (strict) throw new SafeVercelError("Vercel runtime logs returned an invalid response.");
    }
  }
  return logs;
}

function logValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && value.timestamp === undefined && value.createdAt === undefined && value.time === undefined) {
    for (const key of ["rows", "logs", "data"]) if (Array.isArray(value[key])) return value[key];
  }
  return [value];
}

async function vercelJson(url: URL, token: string, fetcher: typeof fetch) {
  return withDeadline("Vercel API request", async (controller) => {
    const text = await readResponse(url, token, fetcher, controller, "Vercel API request");
    const value = tryJson(text);
    if (value === undefined) throw new SafeVercelError("Vercel API returned an invalid response.");
    return value;
  });
}

async function withDeadline<T>(label: string, operation: (controller: AbortController) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await abortable(operation(controller), controller.signal);
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) {
      throw new SafeVercelError(`${label} timed out.`);
    }
    if (error instanceof SafeVercelError) throw error;
    // Never forward fetch errors, response bodies, URLs, or their causes.
    throw new SafeVercelError(`${label} failed safely.`);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Request aborted", "AbortError"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function readResponse(url: URL, token: string, fetcher: typeof fetch, controller: AbortController, label: string, limit?: number) {
  const response = await abortable(fetcher(url, {
    signal: controller.signal,
    headers: { authorization: `Bearer ${token}`, accept: "application/json, application/x-ndjson" },
  }), controller.signal);
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new SafeVercelError(`${label} failed (HTTP ${response.status}).`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const streaming = /event-stream|ndjson|stream\+json/.test(response.headers.get("content-type") ?? "");
  const streamTimer = streaming ? setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS) : undefined;
  const decoder = new TextDecoder();
  let text = "";
  let pending = "";
  let eventData: string[] = [];
  let count = 0;
  let bytes = 0;
  const sse = /event-stream/.test(response.headers.get("content-type") ?? "");
  const acceptRecord = (record: string): boolean => {
    if (record === "[DONE]") return true;
    const value = tryJson(record);
    if (value === undefined) throw new SafeVercelError("Vercel runtime logs returned an invalid response.");
    text += JSON.stringify(value) + "\n";
    count += logValues(value).length;
    if (limit !== undefined && count >= limit) throw new SafeVercelError("Vercel runtime logs stream reached the safe log limit before completion.");
    return false;
  };
  try {
    while (true) {
      const idleTimer = streaming ? setTimeout(() => controller.abort(), STREAM_IDLE_MS) : undefined;
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await abortable(reader.read(), controller.signal); }
      finally { clearTimeout(idleTimer); }
      if (chunk.done) {
        pending += decoder.decode();
        if (!streaming) return text + pending;
        if (sse) {
          if (pending.startsWith("data:")) eventData.push(pending.slice(5).trimStart());
          if (eventData.length) acceptRecord(eventData.join("\n"));
        } else if (pending.trim()) acceptRecord(pending.trim());
        return text;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new SafeVercelError(`${label} response exceeded the safe size limit.`);
      const decoded = decoder.decode(chunk.value, { stream: true });
      if (!streaming) { text += decoded; continue; }
      pending += decoded;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (sse) {
          if (line.startsWith("data:")) eventData.push(line.slice(5).trimStart());
          else if (!line && eventData.length) {
            const record = eventData.join("\n");
            eventData = [];
            if (acceptRecord(record)) return text;
          }
        } else if (line.trim() && acceptRecord(line.trim())) return text;
      }
    }
  } finally {
    clearTimeout(streamTimer);
    // Cancellation itself can hang with a broken source; never await it.
    void reader.cancel().catch(() => {}).finally(() => reader.releaseLock());
  }
}

function normalizeLog(value: Record<string, unknown>, deploymentId: string): RuntimeLog | null {
  const rawTimestamp = value.timestamp ?? value.createdAt ?? value.time;
  const timestamp = typeof rawTimestamp === "number" ? (rawTimestamp < 10_000_000_000 ? rawTimestamp * 1000 : rawTimestamp) : Date.parse(String(rawTimestamp ?? ""));
  if (!Number.isFinite(timestamp)) return null;
  const status = numberValue(value.statusCode ?? value.status);
  return {
    ...value,
    timestamp,
    deploymentId: stringValue(value.deploymentId) || deploymentId,
    environment: stringValue(value.environment) || "production",
    ...(status === null ? {} : { statusCode: status }),
    ...(typeof value.requestId === "string" && !value.id ? { id: value.requestId } : {}),
    level: stringValue(value.level) || nestedLevel(value.logs),
    method: stringValue(value.method ?? value.requestMethod),
    message: Array.isArray(value.logs) ? value.logs.filter(isRecord).map((entry) => messageValue(entry.message)).join("\n") : messageValue(value.message ?? value.text ?? value.proxy),
  };
}

function nestedLevel(logs: unknown): string {
  if (!Array.isArray(logs)) return "";
  const levels = logs.filter(isRecord).map((entry) => entry.level);
  return ["fatal", "error", "warning", "info"].find((level) => levels.includes(level)) ?? "";
}

function tryJson(value: string): unknown | undefined { try { return JSON.parse(value) as unknown; } catch { return undefined; } }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function stringValue(value: unknown) { return typeof value === "string" ? value : ""; }
function numberValue(value: unknown) { const number = typeof value === "number" ? value : Number(value); return Number.isFinite(number) ? number : null; }
function messageValue(value: unknown) { return typeof value === "string" ? value : value === undefined ? "" : redactSecrets(value); }
