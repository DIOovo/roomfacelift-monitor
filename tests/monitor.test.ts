import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeLogs } from "../src/analyze.js";
import { detectError } from "../src/detect.js";
import { buildFeishuPayload } from "../src/feishu.js";
import { runMonitor } from "../src/monitor.js";
import { redactSecrets } from "../src/redact.js";
import { emptyState, saveState } from "../src/state.js";
import type { Alert, MonitorConfig, RuntimeLog } from "../src/types.js";
import { getRuntimeLogs } from "../src/vercel.js";

const NOW = 1_788_912_100_000;

test("200, ordinary 401, and ordinary 403 do not alert", () => {
  assert.equal(detectError(log({ statusCode: 200, route: "/" })), null);
  const result = analyzeLogs([
    log({ id: "401", statusCode: 401, route: "/api/generate", message: "Unauthenticated" }),
    log({ id: "403", statusCode: 403, route: "/api/waffo/checkout", message: "Test restriction" }),
  ], emptyState(), NOW);
  assert.equal(result.alerts.length, 0);
});

test("generate 500, room-image unexpected 400, 413, and Waffo checkout failure alert", () => {
  const result = analyzeLogs([
    log({ id: "a", statusCode: 500, route: "/api/generate", level: "error", message: "generation failed" }),
    log({ id: "b", statusCode: 400, route: "/api/uploads/room-image", message: "Only PNG and JPG images are accepted" }),
    log({ id: "c", statusCode: 413, route: "/api/generate", message: "413 Request Entity Too Large" }),
    log({ id: "d", statusCode: 400, route: "/api/waffo/checkout", message: "Waffo checkout creation failed" }),
  ], emptyState(), NOW);
  assert.equal(result.alerts.length, 4);
  assert.equal(result.alerts[0]?.severity, "CRITICAL");
  assert.ok(result.alerts.some((alert) => alert.route === "/api/uploads/room-image"));
  assert.ok(result.alerts.some((alert) => alert.statusCode === 413));
  assert.ok(result.alerts.some((alert) => alert.summary.includes("Waffo")));
});

test("duplicate log IDs are processed once and identical errors aggregate", () => {
  const first = log({ id: "same-id", statusCode: 500, route: "/api/generate", message: "generation failed", timestamp: NOW });
  const initial = analyzeLogs([first, first], emptyState(), NOW);
  assert.equal(initial.alerts.length, 1);
  assert.equal(initial.state.recentFingerprints[initial.alerts[0]!.fingerprint]?.count, 1);

  const later = analyzeLogs([
    log({ id: "next-1", statusCode: 500, route: "/api/generate", message: "generation failed", timestamp: NOW + 1_000 }),
    log({ id: "next-2", statusCode: 500, route: "/api/generate", message: "generation failed", timestamp: NOW + 2_000 }),
  ], { ...initial.state, pendingAlerts: [] }, NOW + 2_000);
  const fingerprint = initial.alerts[0]!.fingerprint;
  assert.equal(later.alerts.length, 0);
  assert.equal(later.state.recentFingerprints[fingerprint]?.count, 3);

  const sustained = analyzeLogs([log({ id: "next-3", statusCode: 500, route: "/api/generate", message: "generation failed", timestamp: NOW + 301_000 })], later.state, NOW + 301_000);
  assert.equal(sustained.alerts.length, 1);
  assert.equal(sustained.alerts[0]?.occurrences, 4);
});

test("secrets, signed URLs, UUIDs, and email addresses are redacted before Feishu payloads", () => {
  const raw = "Authorization: Bearer abc.def.ghi cookie=session=secret email jane@example.com user 123e4567-e89b-42d3-a456-426614174000 https://x.test/a?token=secret";
  const redacted = redactSecrets(raw);
  for (const secret of ["abc.def.ghi", "session=secret", "jane@example.com", "123e4567-e89b-42d3-a456-426614174000", "token=secret", "https://x.test/a"]) assert.doesNotMatch(redacted, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const payload = JSON.stringify(buildFeishuPayload(alert({ summary: raw })));
  assert.doesNotMatch(payload, /jane@example\.com|abc\.def\.ghi|123e4567/);
});

test("preview logs are ignored and production logs are processed", () => {
  const result = analyzeLogs([
    log({ id: "preview", environment: "preview", statusCode: 500 }),
    log({ id: "production", environment: "production", statusCode: 500 }),
  ], emptyState(), NOW);
  assert.equal(result.alerts.length, 1);
});

test("Feishu failure retains pending alerts in persisted state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roomfacelift-monitor-"));
  const statePath = join(directory, "state.json");
  await saveState(statePath, emptyState());
  const fixturePath = join(directory, "logs.json");
  await BunlessWrite(fixturePath, JSON.stringify([log({ id: "fatal", statusCode: 500, route: "/api/generate" })]));
  await assert.rejects(runMonitor({ config: config(), dryRun: false, fixturePath, statePath, now: NOW, fetcher: async () => new Response("failed", { status: 500 }) }), /Feishu webhook failed/);
  const persisted = JSON.parse(await readFile(statePath, "utf8")) as { pendingAlerts: unknown[]; processedLogIds: Record<string, number> };
  assert.equal(persisted.pendingAlerts.length, 1);
  assert.ok(persisted.processedLogIds.fatal);
});

test("Vercel API failures are safe and do not expose bearer tokens", async () => {
  const secret = "super-secret-vercel-token";
  await assert.rejects(
    getRuntimeLogs({
      config: { ...config(), vercelToken: secret },
      deploymentId: "dpl_test",
      since: 0,
      until: NOW,
      runner: async () => ({ exitCode: 1, stdout: "", stderr: `Bearer ${secret} jane@example.com` }),
    }),
    (error) => error instanceof Error && !error.message.includes(secret) && !error.message.includes("jane@example.com"),
  );
});

function log(overrides: Partial<RuntimeLog>): RuntimeLog {
  return { id: "log-default", timestamp: NOW, environment: "production", deploymentId: "dpl_test", method: "POST", route: "/api/generate", statusCode: 200, level: "warning", message: "request", requestId: "req_test", ...overrides };
}

function alert(overrides: Partial<Alert>): Alert {
  return { id: "alert", fingerprint: "fingerprint", severity: "ERROR", time: NOW, method: "POST", route: "/api/generate", statusCode: 500, summary: "generation failed", occurrences: 1, requestId: "req_test", deploymentId: "dpl_test", ...overrides };
}

function config(): MonitorConfig {
  return { vercelToken: "vercel", vercelProjectId: "project", vercelTeamId: "team", feishuWebhookUrl: "https://example.test/hook" };
}

async function BunlessWrite(path: string, value: string) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, value);
}
