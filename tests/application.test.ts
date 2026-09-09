import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runApplication } from "../src/application.js";
import { emptyState, saveState } from "../src/state.js";

const NOW = 1_788_912_100_000;

test("self-test calls Feishu directly without Vercel or state changes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "roomfacelift-self-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  await saveState(statePath, { ...emptyState(), lastProcessedTimestamp: NOW - 30_000 });
  const before = await readFile(statePath, "utf8");
  const webhook = "https://example.test/feishu-self-test";
  const secret = "self-test-secret-that-must-never-be-logged";
  const logs: string[] = [];
  let feishuCalls = 0;

  await runApplication({
    args: ["--dry-run", "--send-test-alert"],
    environment: {
      FEISHU_WEBHOOK_URL: webhook,
      FEISHU_WEBHOOK_SECRET: secret,
    },
    statePath,
    now: NOW,
    onLog: (message) => logs.push(message),
    monitorRunner: async () => { throw new Error("Vercel monitor must not run"); },
    fetcher: async (target, options) => {
      feishuCalls++;
      assert.equal(String(target), webhook);
      assert.equal(options?.method, "POST");
      const body = String(options?.body);
      assert.match(body, /Synthetic monitoring test/);
      assert.match(body, /\/monitor\/self-test/);
      assert.match(body, /"timestamp"/);
      assert.match(body, /"sign"/);
      assert.ok(!body.includes(secret));
      return Response.json({ code: 0 });
    },
  });

  assert.equal(feishuCalls, 1);
  assert.equal(await readFile(statePath, "utf8"), before);
  assert.deepEqual(logs, [
    "Sending Feishu self-test...",
    "Feishu self-test sent successfully.",
  ]);
  assert.ok(!logs.join("\n").includes(webhook));
  assert.ok(!logs.join("\n").includes(secret));
});

test("self-test does not create a missing state file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "roomfacelift-self-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");

  await runApplication({
    args: ["--send-test-alert"],
    environment: { FEISHU_WEBHOOK_URL: "https://example.test/hook" },
    statePath,
    onLog: () => {},
    feishuSender: async ({ alert }) => {
      assert.deepEqual({
        severity: alert.severity,
        route: alert.route,
        method: alert.method,
        statusCode: alert.statusCode,
        summary: alert.summary,
        occurrences: alert.occurrences,
        requestId: alert.requestId,
        deploymentId: alert.deploymentId,
      }, {
        severity: "CRITICAL",
        route: "/monitor/self-test",
        method: "TEST",
        statusCode: 500,
        summary: "Synthetic monitoring test",
        occurrences: 1,
        requestId: "self-test",
        deploymentId: "self-test",
      });
    },
    monitorRunner: async () => { throw new Error("Vercel monitor must not run"); },
  });

  await assert.rejects(readFile(statePath), { code: "ENOENT" });
});

test("workflow dispatch isolates self-test secrets and skips state steps", async () => {
  const workflow = await readFile(new URL("../.github/workflows/monitor.yml", import.meta.url), "utf8");
  assert.match(workflow, /send_test_alert:\n\s+description: Send a synthetic alert to Feishu/);
  assert.match(workflow, /run: npm --silent run monitor -- --send-test-alert/);
  assert.match(workflow, /if: \$\{\{ !inputs\.send_test_alert \}\}/);
  const selfTestStep = workflow.slice(workflow.indexOf("- name: Send Feishu self-test"), workflow.indexOf("- name: Monitor production runtime logs"));
  assert.match(selfTestStep, /FEISHU_WEBHOOK_URL/);
  assert.match(selfTestStep, /FEISHU_WEBHOOK_SECRET/);
  assert.doesNotMatch(selfTestStep, /VERCEL_TOKEN|VERCEL_PROJECT_ID|VERCEL_TEAM_ID/);
});
