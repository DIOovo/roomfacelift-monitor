import { randomUUID } from "node:crypto";
import { detectError } from "./detect.js";
import { fingerprintFor, logRoute, logStatus, stableLogId } from "./normalize.js";
import type { Alert, MonitorState, RuntimeLog } from "./types.js";

const WINDOW_MS = 5 * 60 * 1000;
const NOISE_THRESHOLD = 10;
const RETENTION_MS = 30 * 60 * 1000;

export function analyzeLogs(logs: RuntimeLog[], initial: MonitorState, now = Date.now()) {
  const state = structuredClone(initial);
  const ordered = logs.filter((log) => log.environment === "production").sort((a, b) => a.timestamp - b.timestamp);
  const seenIds = new Set(Object.keys(state.processedLogIds));
  const newLogs = ordered.filter((log) => {
    const id = stableLogId(log);
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });
  const noiseCounts = countExpectedNoise(newLogs);

  for (const log of newLogs) {
    const logId = stableLogId(log);
    state.processedLogIds[logId] = log.timestamp;
    state.lastProcessedTimestamp = Math.max(state.lastProcessedTimestamp, log.timestamp);
    const detection = detectError(log);
    if (!detection) continue;
    const fingerprint = fingerprintFor(log);
    if (detection.expectedNoise && (noiseCounts.get(fingerprint) ?? 0) < NOISE_THRESHOLD) continue;
    ingestDetection(state, log, fingerprint, detection.severity, detection.summary);
  }

  pruneState(state, now);
  return { state, alerts: state.pendingAlerts };
}

function ingestDetection(state: MonitorState, log: RuntimeLog, fingerprint: string, severity: Alert["severity"], summary: string) {
  const previous = state.recentFingerprints[fingerprint];
  const startsNewWindow = !previous || log.timestamp - previous.lastSeen > WINDOW_MS;
  const current = startsNewWindow
    ? { firstSeen: log.timestamp, lastSeen: log.timestamp, lastAlerted: 0, count: 1, alertedCount: 0 }
    : { ...previous, lastSeen: log.timestamp, count: previous.count + 1 };
  const shouldAlert = current.alertedCount === 0 || log.timestamp - current.lastAlerted >= WINDOW_MS;
  if (shouldAlert) {
    const alert = makeAlert(log, fingerprint, severity, summary, current.count);
    if (!state.pendingAlerts.some((item) => item.id === alert.id || (item.fingerprint === fingerprint && item.occurrences === alert.occurrences))) state.pendingAlerts.push(alert);
    current.lastAlerted = log.timestamp;
    current.alertedCount = current.count;
  }
  state.recentFingerprints[fingerprint] = current;
}

function countExpectedNoise(logs: RuntimeLog[]) {
  const counts = new Map<string, number>();
  for (const log of logs) {
    const detection = detectError(log);
    if (!detection?.expectedNoise) continue;
    const fingerprint = fingerprintFor(log);
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }
  return counts;
}

function makeAlert(log: RuntimeLog, fingerprint: string, severity: Alert["severity"], summary: string, occurrences: number): Alert {
  return {
    id: randomUUID(),
    fingerprint,
    severity,
    time: log.timestamp,
    method: typeof log.method === "string" ? log.method : "UNKNOWN",
    route: logRoute(log),
    statusCode: logStatus(log),
    summary,
    occurrences,
    requestId: typeof log.requestId === "string" ? log.requestId : "unknown",
    deploymentId: typeof log.deploymentId === "string" ? log.deploymentId : "unknown",
  };
}

function pruneState(state: MonitorState, now: number) {
  for (const [id, timestamp] of Object.entries(state.processedLogIds)) if (now - timestamp > RETENTION_MS) delete state.processedLogIds[id];
  for (const [fingerprint, value] of Object.entries(state.recentFingerprints)) if (now - value.lastSeen > RETENTION_MS) delete state.recentFingerprints[fingerprint];
}
