import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { runMonitor } from "../src/monitor.js";
import { emptyState, saveState } from "../src/state.js";
import type { MonitorConfig } from "../src/types.js";
import {
  buildVercelLogsArgs,
  getLatestProductionDeployment,
  getRuntimeLogs,
  runVercelLogsCli,
  SafeVercelError,
} from "../src/vercel.js";
import type { VercelLogsRunner } from "../src/vercel.js";

const NOW = 1_788_912_100_000;
const config: MonitorConfig = {
  vercelToken: "opaque-private-token",
  vercelProjectId: "private-project",
  vercelTeamId: "private-team",
  feishuWebhookUrl: "https://example.test/private-hook",
  feishuWebhookSecret: "private-hook-secret",
};
const entry = {
  id: "req_one",
  timestamp: NOW - 1_000,
  deploymentId: "dpl_test",
  environment: "production",
  responseStatusCode: 500,
  requestMethod: "POST",
  requestPath: "/api/generate",
  level: "error",
  message: "request failed",
};
const input = { config, deploymentId: "dpl_test", since: NOW - 60_000, until: NOW };

function runner(result: Partial<Awaited<ReturnType<VercelLogsRunner>>>): VercelLogsRunner {
  return async () => ({ exitCode: 0, stdout: "", stderr: "", ...result });
}

test("deployment API returns quickly with an independent abort signal", async () => {
  const id = await getLatestProductionDeployment(config, async (url, options) => {
    assert.equal(new URL(String(url)).pathname, "/v6/deployments");
    assert.ok(options?.signal);
    assert.equal(options.signal.aborted, false);
    return Response.json({ deployments: [{ uid: "dpl_test", target: "production" }] });
  });
  assert.equal(id, "dpl_test");
});

test("CLI JSON log output is normalized", async () => {
  const logs = await getRuntimeLogs({ ...input, runner: runner({ stdout: JSON.stringify(entry) }) });
  assert.deepEqual(logs.map(({ timestamp, statusCode, method, path, level, message, requestId, deploymentId, environment }) => ({
    timestamp, statusCode, method, path, level, message, requestId, deploymentId, environment,
  })), [{
    timestamp: NOW - 1_000,
    statusCode: 500,
    method: "POST",
    path: "/api/generate",
    level: "error",
    message: "request failed",
    requestId: "req_one",
    deploymentId: "dpl_test",
    environment: "production",
  }]);
});

test("CLI NDJSON output parses multiple logs", async () => {
  const stdout = [entry, { ...entry, id: "req_two", timestamp: NOW - 500 }].map((value) => JSON.stringify(value)).join("\n");
  const logs = await getRuntimeLogs({ ...input, runner: runner({ stdout }) });
  assert.deepEqual(logs.map((log) => log.requestId), ["req_one", "req_two"]);
});

test("empty CLI output returns no logs", async () => {
  assert.deepEqual(await getRuntimeLogs({ ...input, runner: runner({ stdout: "\n" }) }), []);
});

test("CLI non-zero exit exposes a safe useful error", async () => {
  await assert.rejects(
    getRuntimeLogs({ ...input, runner: runner({ exitCode: 1, stderr: "Error: account cannot read historical logs" }) }),
    /Vercel logs command failed \(exit 1\): Error: account cannot read historical logs/,
  );
});

test("CLI failure never includes partial log stdout", async () => {
  await assert.rejects(
    getRuntimeLogs({ ...input, runner: runner({ exitCode: 1, stdout: "private customer log", stderr: "" }) }),
    (error: unknown) => error instanceof Error && !error.message.includes("private customer log"),
  );
});

test("CLI 403 is reported without an undocumented fallback", async () => {
  await assert.rejects(
    getRuntimeLogs({ ...input, runner: runner({ exitCode: 1, stderr: "Error: Forbidden (403)" }) }),
    /Forbidden \(403\)/,
  );
});

test("CLI errors redact token, project, team, webhook, email, UUID, URL, cookie and authorization", async () => {
  const raw = `${Object.values(config).join(" ")} jane@example.com 123e4567-e89b-42d3-a456-426614174000 cookie=session-secret Authorization: Bearer abc.def.ghi`;
  await assert.rejects(getRuntimeLogs({ ...input, runner: runner({ exitCode: 1, stderr: raw }) }), (error: unknown) => {
    assert.ok(error instanceof Error);
    for (const secret of [...Object.values(config), "jane@example.com", "123e4567", "session-secret", "abc.def.ghi"]) {
      assert.ok(!error.message.includes(secret));
    }
    return true;
  });
});

test("historical command has exact bounded flags and token remains one argv element", async () => {
  const hostile: MonitorConfig = {
    ...config,
    vercelToken: "token; echo stolen",
    vercelProjectId: "project && touch /tmp/pwned",
    vercelTeamId: "team $(id)",
  };
  let captured: string[] = [];
  await getRuntimeLogs({ ...input, config: hostile, runner: async (args, token) => {
    captured = args;
    assert.equal(token, hostile.vercelToken);
    return { exitCode: 0, stdout: "", stderr: "" };
  } });
  assert.deepEqual(captured, [
    "logs",
    "--deployment", "dpl_test",
    "--project", hostile.vercelProjectId,
    "--scope", hostile.vercelTeamId,
    "--environment", "production",
    "--since", new Date(input.since).toISOString(),
    "--until", new Date(input.until).toISOString(),
    "--limit", "1000",
    "--json",
    "--no-follow",
    "--non-interactive",
    "--no-color",
    "--token", hostile.vercelToken,
  ]);
});

test("spawn uses Node plus argv array and never enables a shell", async () => {
  let seen = false;
  const spawnCommand = ((command: string, args: readonly string[], options: { shell?: boolean; env?: NodeJS.ProcessEnv }) => {
    seen = true;
    assert.equal(command, process.execPath);
    assert.ok(args[0]?.endsWith("node_modules/vercel/dist/index.js"));
    assert.deepEqual(args.slice(1), ["logs", "--token", config.vercelToken]);
    assert.notEqual(options.shell, true);
    for (const name of ["VERCEL_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID", "FEISHU_WEBHOOK_URL", "FEISHU_WEBHOOK_SECRET"]) {
      assert.equal(options.env?.[name], undefined);
    }
    assert.equal(options.env?.NO_UPDATE_NOTIFIER, "1");
    const child = fakeChild();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  }) as unknown as typeof spawn;
  await runVercelLogsCli(["logs", "--token", config.vercelToken], config.vercelToken, spawnCommand);
  assert.ok(seen);
});

test("CLI timeout sends SIGTERM then SIGKILL and reports a fixed error", async () => {
  const signals: NodeJS.Signals[] = [];
  const spawnCommand = (() => {
    const child = fakeChild();
    child.kill = ((signal: NodeJS.Signals) => {
      signals.push(signal);
      if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null));
      return true;
    }) as typeof child.kill;
    return child;
  }) as unknown as typeof spawn;
  await assert.rejects(runVercelLogsCli(["logs"], config.vercelToken, spawnCommand, 5, 5), {
    message: "Vercel logs command timed out.",
  });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("logs query retries once after a CLI timeout and succeeds", async () => {
  let calls = 0;
  const flakyRunner: VercelLogsRunner = async () => {
    calls++;
    if (calls === 1) throw new SafeVercelError("Vercel logs command timed out.", { retryable: true });
    return { exitCode: 0, stdout: JSON.stringify(entry), stderr: "" };
  };
  const logs = await getRuntimeLogs({ ...input, runner: flakyRunner, retryDelayMs: 0 });
  assert.equal(calls, 2);
  assert.equal(logs.length, 1);
});

test("logs query fails after two timeouts without further retries", async () => {
  let calls = 0;
  const timeoutRunner: VercelLogsRunner = async () => {
    calls++;
    throw new SafeVercelError("Vercel logs command timed out.", { retryable: true });
  };
  await assert.rejects(
    getRuntimeLogs({ ...input, runner: timeoutRunner, retryDelayMs: 0 }),
    /Vercel logs command timed out\./,
  );
  assert.equal(calls, 2);
});

test("recoverable CLI temporary failure retries once and succeeds", async () => {
  let calls = 0;
  const flakyRunner: VercelLogsRunner = async () => {
    calls++;
    if (calls === 1) return { exitCode: 1, stdout: "", stderr: "Error: rate limit exceeded" };
    return { exitCode: 0, stdout: JSON.stringify(entry), stderr: "" };
  };
  const logs = await getRuntimeLogs({ ...input, runner: flakyRunner, retryDelayMs: 0 });
  assert.equal(calls, 2);
  assert.equal(logs.length, 1);
});

test("logs query does not retry after a successful first attempt", async () => {
  let calls = 0;
  const successRunner: VercelLogsRunner = async () => {
    calls++;
    return { exitCode: 0, stdout: JSON.stringify(entry), stderr: "" };
  };
  await getRuntimeLogs({ ...input, runner: successRunner, retryDelayMs: 0 });
  assert.equal(calls, 1);
});

test("non-retryable CLI failure is not retried", async () => {
  let calls = 0;
  const forbiddenRunner: VercelLogsRunner = async () => {
    calls++;
    return { exitCode: 1, stdout: "", stderr: "Error: Forbidden (403)" };
  };
  await assert.rejects(
    getRuntimeLogs({ ...input, runner: forbiddenRunner, retryDelayMs: 0 }),
    /Forbidden \(403\)/,
  );
  assert.equal(calls, 1);
});

test("dry-run does not call Feishu or persist state and reports safe stages", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vercel-monitor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  await saveState(statePath, emptyState());
  const before = await readFile(statePath, "utf8");
  let fetchCalls = 0;
  let cliCalls = 0;
  const progress: string[] = [];
  const result = await runMonitor({
    config,
    dryRun: true,
    statePath,
    now: NOW,
    onProgress: (message) => progress.push(message),
    fetcher: async () => {
      fetchCalls++;
      return Response.json({ deployments: [{ uid: "dpl_test" }] });
    },
    vercelLogsRunner: async () => {
      cliCalls++;
      return { exitCode: 0, stdout: JSON.stringify(entry), stderr: "" };
    },
  });
  assert.equal(fetchCalls, 1);
  assert.equal(cliCalls, 1);
  assert.equal(result.statePersisted, false);
  assert.equal(await readFile(statePath, "utf8"), before);
  assert.deepEqual(progress, [
    "Resolving production deployment...",
    "Production deployment resolved.",
    "Fetching runtime logs with Vercel CLI...",
    "Runtime logs received: 1",
    "Analyzing logs...",
    "Alerts detected: 1",
    "Dry run completed.",
  ]);
});

test("preview logs are filtered even if CLI returns them", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vercel-monitor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stdout = [entry, { ...entry, id: "preview", environment: "preview" }].map((value) => JSON.stringify(value)).join("\n");
  const result = await runMonitor({
    config,
    dryRun: true,
    statePath: join(directory, "state.json"),
    now: NOW,
    fetcher: async () => Response.json({ deployments: [{ uid: "dpl_test" }] }),
    vercelLogsRunner: runner({ stdout }),
  });
  assert.equal(result.logsRead, 1);
});

test("historical window is initial ten minutes, then state timestamp minus one second", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vercel-monitor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const windows: Array<{ since: string; until: string }> = [];
  const capture: VercelLogsRunner = async (args) => {
    windows.push({ since: args[args.indexOf("--since") + 1]!, until: args[args.indexOf("--until") + 1]! });
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const base = {
    config,
    dryRun: true,
    statePath,
    now: NOW,
    fetcher: async () => Response.json({ deployments: [{ uid: "dpl_test" }] }),
    vercelLogsRunner: capture,
  };
  await runMonitor(base);
  await saveState(statePath, { ...emptyState(), lastProcessedTimestamp: NOW - 30_000 });
  await runMonitor(base);
  assert.deepEqual(windows, [
    { since: new Date(NOW - 10 * 60_000).toISOString(), until: new Date(NOW).toISOString() },
    { since: new Date(NOW - 31_000).toISOString(), until: new Date(NOW).toISOString() },
  ]);
});

test("records outside the requested window are discarded", async () => {
  const stdout = [entry, { ...entry, timestamp: input.since - 1 }, { ...entry, timestamp: input.until + 1 }]
    .map((value) => JSON.stringify(value)).join("\n");
  const logs = await getRuntimeLogs({ ...input, runner: runner({ stdout }) });
  assert.equal(logs.length, 1);
});

test("invalid JSON output fails safely", async () => {
  await assert.rejects(getRuntimeLogs({ ...input, runner: runner({ stdout: "not-json" }) }), /invalid JSON output/);
});

test("argument builder rejects invalid dates before starting CLI", () => {
  assert.throws(() => buildVercelLogsArgs({ ...input, since: Number.NaN }), /Invalid time value/);
});

function fakeChild() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = (() => true) as typeof child.kill;
  return child;
}
