import { createHash } from "node:crypto";
import { redactSecrets } from "./redact.js";
import type { RuntimeLog } from "./types.js";

export function logStatus(log: RuntimeLog) {
  const value = log.statusCode ?? log.status;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function logRoute(log: RuntimeLog) {
  const raw = firstString(log.route, log.requestPath, log.path) || "unknown";
  try {
    return new URL(raw, "https://monitor.invalid").pathname;
  } catch {
    return raw.split("?", 1)[0] || "unknown";
  }
}

export function normalizedMessage(log: RuntimeLog) {
  const raw = firstString(log.message) || (logStatus(log) ? `HTTP ${logStatus(log)}` : "Runtime error");
  return redactSecrets(raw)
    .replace(/\b(?:req|request|trace|invocation)[-_ ]?id\s*[:=]\s*[^\s,]+/gi, "requestId=[ID]")
    .replace(/\b\d{2,}\b/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

export function fingerprintFor(log: RuntimeLog) {
  const source = `${logRoute(log)}\n${logStatus(log) ?? "none"}\n${normalizedMessage(log).toLowerCase()}`;
  return createHash("sha256").update(source).digest("hex");
}

export function stableLogId(log: RuntimeLog) {
  if (typeof log.id === "string" && log.id) return log.id;
  const source = `${log.requestId ?? ""}\n${log.timestamp}\n${logRoute(log)}\n${log.message ?? ""}`;
  return createHash("sha256").update(source).digest("hex");
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() ?? "";
}
