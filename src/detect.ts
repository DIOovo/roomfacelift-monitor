import { logRoute, logStatus, normalizedMessage } from "./normalize.js";
import type { RuntimeLog, Severity } from "./types.js";

const P0_TERMS = /Unhandled|uncaught|FUNCTION_INVOCATION_FAILED|timeout|out of memory|\bOOM\b/i;
const KNOWN_PATTERNS = /413 Request Entity Too Large|Only PNG and JPG images are accepted|NEXT_PUBLIC_SITE_URL must be a public HTTPS URL|Waffo checkout creation failed|Private key could not be parsed|webhook verification failed|credit fulfillment failed|generation failed|storage upload failed|fal provider failed|watermark failed/i;
const IMPORTANT_ROUTE = /^(?:\/api\/generate|\/api\/(?:uploads\/)?room-image|\/api\/waffo\/(?:checkout|webhook)|\/api\/stripe\/|\/auth\/callback)/;
const EXPECTED_STATUS = new Set([401, 403, 429]);

export type Detection = { severity: Severity; summary: string; expectedNoise: boolean };

export function detectError(log: RuntimeLog): Detection | null {
  if (log.environment && log.environment !== "production") return null;
  const status = logStatus(log);
  const level = String(log.level ?? "").toLowerCase();
  const message = normalizedMessage(log);
  const route = logRoute(log);
  const paymentCritical = /\/api\/(?:waffo|stripe)\/webhook/.test(route) && ((status !== null && status >= 400) || /fail|error/i.test(message));

  if (paymentCritical || /credit fulfillment failed/i.test(message)) return { severity: "CRITICAL", summary: message, expectedNoise: false };
  if ((status !== null && status >= 500) || level === "error" || level === "fatal" || P0_TERMS.test(message)) {
    const critical = (status !== null && status >= 500 && route === "/api/generate") || /service unavailable|generation failed|watermark failed/i.test(message);
    return { severity: critical ? "CRITICAL" : "ERROR", summary: message, expectedNoise: false };
  }
  if (status !== null && EXPECTED_STATUS.has(status)) return IMPORTANT_ROUTE.test(route) ? { severity: "WARNING", summary: message, expectedNoise: true } : null;
  if (KNOWN_PATTERNS.test(message) || status === 413) return { severity: /Waffo checkout creation failed/i.test(message) ? "CRITICAL" : "ERROR", summary: message, expectedNoise: false };
  if (status !== null && status >= 400 && IMPORTANT_ROUTE.test(route)) return { severity: "ERROR", summary: message, expectedNoise: false };
  return null;
}
