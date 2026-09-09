import { redactSecrets } from "./redact.js";
import type { MonitorConfig, RuntimeLog } from "./types.js";

const API = "https://api.vercel.com";

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
  const url = new URL(`/v1/projects/${encodeURIComponent(input.config.vercelProjectId)}/deployments/${encodeURIComponent(input.deploymentId)}/runtime-logs`, API);
  url.searchParams.set("teamId", input.config.vercelTeamId);
  url.searchParams.set("environment", "production");
  url.searchParams.set("since", String(input.since));
  url.searchParams.set("until", String(input.until));
  url.searchParams.set("limit", "1000");
  const response = await (input.fetcher ?? fetch)(url, { headers: { authorization: `Bearer ${input.config.vercelToken}`, accept: "application/json, application/x-ndjson, text/event-stream" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`Vercel runtime logs request failed (${response.status}): ${safeApiMessage(text)}`);
  return parseRuntimeLogs(text, input.deploymentId);
}

export function parseRuntimeLogs(text: string, deploymentId: string): RuntimeLog[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parsed = tryJson(trimmed);
  const values = parsed === undefined
    ? trimmed.split("\n").map((line) => line.replace(/^data:\s*/, "").trim()).filter((line) => line && line !== "[DONE]").map(tryJson).filter((value) => value !== undefined)
    : Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.logs) ? parsed.logs : isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : [parsed];
  return values.filter(isRecord).map((value) => normalizeLog(value, deploymentId)).filter((value): value is RuntimeLog => value !== null);
}

async function vercelJson(url: URL, token: string, fetcher: typeof fetch) {
  const response = await fetcher(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`Vercel API request failed (${response.status}): ${safeApiMessage(text)}`);
  const value = tryJson(text);
  if (value === undefined) throw new Error("Vercel API returned an invalid response.");
  return value;
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
    message: messageValue(value.message ?? value.text ?? value.proxy),
  };
}

function safeApiMessage(text: string) {
  const value = tryJson(text);
  const message = isRecord(value) && typeof value.error === "object" && value.error && "message" in value.error
    ? String((value.error as { message?: unknown }).message ?? "")
    : isRecord(value) && typeof value.message === "string" ? value.message : "Request failed";
  return redactSecrets(message).slice(0, 240);
}

function tryJson(value: string): unknown | undefined { try { return JSON.parse(value) as unknown; } catch { return undefined; } }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function stringValue(value: unknown) { return typeof value === "string" ? value : ""; }
function numberValue(value: unknown) { const number = typeof value === "number" ? value : Number(value); return Number.isFinite(number) ? number : null; }
function messageValue(value: unknown) { return typeof value === "string" ? value : value === undefined ? "" : redactSecrets(value); }
