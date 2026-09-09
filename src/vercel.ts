import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "./redact.js";
import type { MonitorConfig, RuntimeLog } from "./types.js";

const API = "https://api.vercel.com";
const REQUEST_TIMEOUT_MS = 20_000;
const CLI_TIMEOUT_MS = 20_000;
const CLI_KILL_GRACE_MS = 1_000;
const LOG_LIMIT = 1000;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
const VERCEL_CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../node_modules/vercel/dist/index.js");

class SafeVercelError extends Error {}

export type VercelLogsRunner = (args: string[], token: string) => Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}>;

export async function getLatestProductionDeployment(config: MonitorConfig, fetcher: typeof fetch = fetch) {
  const url = new URL("/v6/deployments", API);
  url.searchParams.set("projectId", config.vercelProjectId);
  url.searchParams.set("teamId", config.vercelTeamId);
  url.searchParams.set("target", "production");
  url.searchParams.set("limit", "1");
  const value = await vercelJson(url, config.vercelToken, fetcher) as {
    deployments?: Array<{ uid?: string; id?: string; target?: string }>;
  };
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
  runner?: VercelLogsRunner;
}) {
  const args = buildVercelLogsArgs(input);
  const result = await (input.runner ?? runVercelLogsCli)(args, input.config.vercelToken);
  if (result.exitCode !== 0) {
    const detail = safeCliMessage(result.stderr, input.config);
    throw new SafeVercelError(`Vercel logs command failed (exit ${result.exitCode ?? "unknown"})${detail ? `: ${detail}` : "."}`);
  }
  const logs = parseRuntimeLogs(result.stdout, input.deploymentId, true);
  return logs.filter((log) => log.timestamp >= input.since && log.timestamp <= input.until);
}

export function buildVercelLogsArgs(input: {
  config: MonitorConfig;
  deploymentId: string;
  since: number;
  until: number;
}) {
  return [
    "logs",
    "--deployment", input.deploymentId,
    "--project", input.config.vercelProjectId,
    "--scope", input.config.vercelTeamId,
    "--environment", "production",
    "--since", new Date(input.since).toISOString(),
    "--until", new Date(input.until).toISOString(),
    "--limit", String(LOG_LIMIT),
    "--json",
    "--no-follow",
    "--non-interactive",
    "--no-color",
    "--token", input.config.vercelToken,
  ];
}

export function runVercelLogsCli(
  args: string[],
  token: string,
  spawnCommand: typeof spawn = spawn,
  timeoutMs = CLI_TIMEOUT_MS,
  killGraceMs = CLI_KILL_GRACE_MS,
) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawnCommand(process.execPath, [VERCEL_CLI, ...args], {
      cwd: process.cwd(),
      env: cliEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let killTimer: NodeJS.Timeout | undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        outputExceeded = true;
        child.kill("SIGTERM");
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += chunk.toString("utf8").slice(0, MAX_STDERR_BYTES - stderr.length);
      }
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
    }, timeoutMs);

    child.once("error", () => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      reject(new SafeVercelError("Vercel logs command could not be started."));
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      if (timedOut) {
        reject(new SafeVercelError("Vercel logs command timed out."));
        return;
      }
      if (outputExceeded) {
        reject(new SafeVercelError("Vercel logs command output exceeded the safe size limit."));
        return;
      }
      resolvePromise({ exitCode, stdout, stderr: safeCliMessage(stderr, { vercelToken: token }) });
    });
  });
}

function cliEnvironment() {
  const env = { ...process.env };
  for (const name of [
    "VERCEL_TOKEN",
    "VERCEL_PROJECT_ID",
    "VERCEL_TEAM_ID",
    "FEISHU_WEBHOOK_URL",
    "FEISHU_WEBHOOK_SECRET",
  ]) delete env[name];
  return { ...env, NO_COLOR: "1", NO_UPDATE_NOTIFIER: "1", VERCEL_TELEMETRY_DISABLED: "1" };
}

export function parseRuntimeLogs(text: string, deploymentId: string, strict = false): RuntimeLog[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parsedWhole = tryJson(trimmed);
  const records = parsedWhole === undefined
    ? trimmed.split("\n").map((line) => line.trim()).filter(Boolean).map(tryJson)
    : logValues(parsedWhole);
  const logs: RuntimeLog[] = [];
  for (const value of records) {
    const log = isRecord(value) ? normalizeLog(value, deploymentId) : null;
    if (log) logs.push(log);
    else if (strict) throw new SafeVercelError("Vercel logs command returned invalid JSON output.");
  }
  return logs;
}

function logValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    for (const key of ["rows", "logs", "data"]) if (Array.isArray(value[key])) return value[key];
  }
  return [value];
}

async function vercelJson(url: URL, token: string, fetcher: typeof fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await abortable(fetcher(url, {
      signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    }), controller.signal);
    if (!response.ok) throw new SafeVercelError(`Vercel API request failed (HTTP ${response.status}).`);
    const text = await abortable(response.text(), controller.signal);
    const value = tryJson(text);
    if (value === undefined) throw new SafeVercelError("Vercel API returned an invalid response.");
    return value;
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) {
      throw new SafeVercelError("Vercel API request timed out.");
    }
    if (error instanceof SafeVercelError) throw error;
    throw new SafeVercelError("Vercel API request failed safely.");
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => reject(new DOMException("Request aborted", "AbortError"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function normalizeLog(value: Record<string, unknown>, deploymentId: string): RuntimeLog | null {
  const rawTimestamp = value.timestamp ?? value.createdAt ?? value.time;
  const timestamp = typeof rawTimestamp === "number"
    ? (rawTimestamp < 10_000_000_000 ? rawTimestamp * 1000 : rawTimestamp)
    : Date.parse(String(rawTimestamp ?? ""));
  if (!Number.isFinite(timestamp)) return null;
  const status = numberValue(value.statusCode ?? value.responseStatusCode ?? value.status);
  const rawId = stringValue(value.id);
  const requestId = stringValue(value.requestId) || rawId;
  const id = rawId || requestId;
  const path = stringValue(value.path ?? value.requestPath ?? value.route);
  return {
    ...value,
    timestamp,
    deploymentId: stringValue(value.deploymentId) || deploymentId,
    environment: stringValue(value.environment) || "production",
    ...(status === null ? {} : { statusCode: status }),
    ...(id ? { id } : {}),
    ...(requestId ? { requestId } : {}),
    level: stringValue(value.level) || nestedLevel(value.logs),
    method: stringValue(value.method ?? value.requestMethod),
    ...(path ? { path, requestPath: path } : {}),
    message: Array.isArray(value.logs)
      ? value.logs.filter(isRecord).map((entry) => messageValue(entry.message)).join("\n")
      : messageValue(value.message ?? value.text ?? value.proxy),
  };
}

function safeCliMessage(value: string, config: Pick<MonitorConfig, "vercelToken"> & Partial<MonitorConfig>) {
  let safe = value.replace(ANSI_ESCAPE, "");
  for (const secret of [
    config.vercelToken,
    config.vercelProjectId,
    config.vercelTeamId,
    config.feishuWebhookUrl,
    config.feishuWebhookSecret,
  ]) {
    if (secret) safe = safe.split(secret).join("[REDACTED]");
  }
  return redactSecrets(safe).trim().slice(0, 600);
}

function nestedLevel(logs: unknown): string {
  if (!Array.isArray(logs)) return "";
  const levels = logs.filter(isRecord).map((entry) => entry.level);
  return ["fatal", "error", "warning", "info"].find((level) => levels.includes(level)) ?? "";
}

function tryJson(value: string): unknown | undefined {
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function stringValue(value: unknown) { return typeof value === "string" ? value : ""; }
function numberValue(value: unknown) { const number = typeof value === "number" ? value : Number(value); return Number.isFinite(number) ? number : null; }
function messageValue(value: unknown) { return typeof value === "string" ? value : value === undefined ? "" : redactSecrets(value); }
