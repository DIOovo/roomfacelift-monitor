import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { runMonitor } from "../src/monitor.js";
import { emptyState, saveState } from "../src/state.js";
import { getLatestProductionDeployment, getRuntimeLogs } from "../src/vercel.js";

const NOW = 1_788_912_100_000;
const config = { vercelToken: "opaque-private-token", vercelProjectId: "private-project", vercelTeamId: "private-team", feishuWebhookUrl: "https://example.test/private-hook", feishuWebhookSecret: "private-hook-secret" };
const entry = { id: "one", timestamp: NOW - 1000, message: "request failed", statusCode: 500, environment: "production" };
const input = { config, deploymentId: "dpl_test", since: NOW - 60_000, until: NOW };
const json = (value: unknown) => Response.json(value);

function openStream(contentType: string, chunks: string[] = []) {
  let cancelled = false;
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) { source = controller; for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); },
    cancel() { cancelled = true; },
  });
  return { response: new Response(body, { headers: { "content-type": contentType } }), cancelled: () => cancelled, send: (text: string) => source.enqueue(encoder.encode(text)) };
}

test("deployment API returns quickly with an independent abort signal", async () => {
  const id = await getLatestProductionDeployment(config, async (url, options) => {
    assert.equal(new URL(String(url)).pathname, "/v6/deployments");
    assert.ok(options?.signal);
    assert.equal(options.signal.aborted, false);
    return json({ deployments: [{ uid: "dpl_test", target: "production" }] });
  });
  assert.equal(id, "dpl_test");
});

test("historical JSON uses CLI endpoint, time bounds and pagination; preserves nested errors", async () => {
  let calls = 0;
  const logs = await getRuntimeLogs({ ...input, fetcher: async (target, options) => {
    const url = new URL(String(target));
    assert.equal(url.origin + url.pathname, "https://vercel.com/api/logs/request-logs");
    assert.equal(url.searchParams.get("startDate"), String(input.since));
    assert.equal(url.searchParams.get("endDate"), String(NOW));
    assert.equal(url.searchParams.get("deploymentId"), "dpl_test");
    assert.equal(url.searchParams.get("environment"), "production");
    assert.equal(url.searchParams.get("ownerId"), config.vercelTeamId);
    assert.equal(url.searchParams.get("page"), String(calls++));
    assert.doesNotMatch(new Headers(options?.headers).get("accept")!, /event-stream/);
    return calls === 1
      ? json({ rows: [{ timestamp: entry.timestamp, requestId: "req_one", requestMethod: "POST", requestPath: "/api/generate", logs: [{ level: "info", message: "first" }, { level: "error", message: "second" }] }], hasMoreRows: true })
      : json({ rows: [entry], hasMoreRows: false });
  } });
  assert.equal(calls, 2);
  assert.equal(logs.length, 2);
  assert.equal(logs[0]?.message, "first\nsecond");
  assert.equal(logs[0]?.level, "error");
  assert.equal(logs[0]?.method, "POST");
  assert.equal(logs[0]?.id, "req_one");
});

for (const payload of [[entry], { logs: [entry] }, { data: [entry] }]) {
  test(`JSON shape ${Object.keys(payload).join()} is accepted`, async () => {
    assert.equal((await getRuntimeLogs({ ...input, fetcher: async () => json(payload) })).length, 1);
  });
}

test("NDJSON handles split UTF-8 chunks and final line without newline", async () => {
  const bytes = new TextEncoder().encode(`${JSON.stringify({ ...entry, message: "错误" })}\n${JSON.stringify({ ...entry, id: "two" })}`);
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const logs = await getRuntimeLogs({ ...input, fetcher: async () => new Response(body, { headers: { "content-type": "application/x-ndjson" } }) });
  assert.equal(logs.length, 2);
  assert.equal(logs[0]?.message, "错误");
});

test("SSE stops at DONE and cancels without waiting for EOF or cancellation completion", async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`: heartbeat\r\nevent: log\r\ndata: ${JSON.stringify(entry)}\r\n\r\ndata: [DONE]\r\n\r\n`));
  }, cancel() { cancelled = true; return new Promise<void>(() => {}); } });
  assert.equal((await getRuntimeLogs({ ...input, fetcher: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }) })).length, 1);
  assert.ok(cancelled);
});

for (const endpoint of ["deployment", "logs"] as const) {
  test(`${endpoint} fetch aborts at 20 seconds even when fetch ignores the signal`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let signal: AbortSignal | undefined;
    const fetcher: typeof fetch = async (_url, options) => { signal = options?.signal ?? undefined; return new Promise<Response>(() => {}); };
    const pending = endpoint === "deployment" ? getLatestProductionDeployment(config, fetcher) : getRuntimeLogs({ ...input, fetcher });
    const rejected = assert.rejects(pending, /Vercel (API|runtime logs) request timed out\./);
    t.mock.timers.tick(19_999);
    assert.equal(signal?.aborted, false);
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(signal?.aborted, true);
  });
}

for (const contentType of ["text/event-stream", "application/x-ndjson", "application/stream+json", "application/json"]) {
  test(`${contentType} stalled response body is aborted and cancelled`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const stream = openStream(contentType);
    const rejected = assert.rejects(getRuntimeLogs({ ...input, fetcher: async () => stream.response }), /Vercel runtime logs request timed out\./);
    await setImmediate();
    t.mock.timers.tick(contentType === "application/json" ? 20_000 : 5_000);
    await rejected;
    assert.ok(stream.cancelled());
  });
}

test("heartbeat traffic cannot extend the 12-second stream deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stream = openStream("text/event-stream");
  const rejected = assert.rejects(getRuntimeLogs({ ...input, fetcher: async () => stream.response }), /timed out/);
  await setImmediate();
  for (let i = 0; i < 2; i++) {
    t.mock.timers.tick(4_000);
    stream.send(": heartbeat\n\n");
    await setImmediate();
  }
  t.mock.timers.tick(4_000);
  await rejected;
  assert.ok(stream.cancelled());
});

test("stream log limit stops and cancels before advancing an incomplete window", async () => {
  const stream = openStream("application/stream+json", [Array.from({ length: 1000 }, () => JSON.stringify(entry)).join("\n") + "\n"]);
  await assert.rejects(getRuntimeLogs({ ...input, fetcher: async () => stream.response }), /safe log limit/);
  assert.ok(stream.cancelled());
});

for (const name of ["AbortError", "TimeoutError"]) {
  test(`${name} becomes a readable safe monitor error`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "vercel-monitor-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let calls = 0;
    await assert.rejects(runMonitor({ config, dryRun: true, statePath: join(directory, "state.json"), fetcher: async () => {
      if (calls++ === 0) return json({ deployments: [{ uid: "dpl_test" }] });
      throw new DOMException(config.vercelToken, name);
    } }), { message: "Monitor could not read Vercel logs safely: Vercel runtime logs request timed out." });
  });
}

test("HTTP and network errors never expose raw secrets, identifiers, URL or response data", async () => {
  const privateText = Object.values(config).join(" ") + " https://api.vercel.com/path?teamId=private-team customer-data";
  for (const fetcher of [async () => { throw new Error(privateText); }, async () => new Response(privateText, { status: 403 })]) {
    for (const request of [getLatestProductionDeployment(config, fetcher), getRuntimeLogs({ ...input, fetcher })]) {
      await assert.rejects(request, (error: unknown) => {
        assert.ok(error instanceof Error);
        for (const secret of [...Object.values(config), "customer-data", "teamId="]) assert.ok(!error.stack?.includes(secret));
        return true;
      });
    }
  }
});

for (const existing of [false, true]) {
  test(`dry-run leaves ${existing ? "existing" : "missing"} state untouched and never calls Feishu`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "vercel-monitor-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const statePath = join(directory, "state.json");
    if (existing) await saveState(statePath, emptyState());
    const before = existing ? await readFile(statePath, "utf8") : undefined;
    let calls = 0;
    const progress: string[] = [];
    const result = await runMonitor({ config, dryRun: true, statePath, now: NOW, onProgress: (message) => progress.push(message), fetcher: async (target) => {
      const url = new URL(String(target));
      calls++;
      if (url.pathname === "/v6/deployments") return json({ deployments: [{ uid: "dpl_test" }] });
      assert.equal(url.pathname, "/api/logs/request-logs", "No Feishu request is allowed");
      return json({ rows: [entry], hasMoreRows: false });
    } });
    assert.equal(calls, 2);
    assert.equal(result.alerts.length, 1);
    assert.equal(result.statePersisted, false);
    if (existing) assert.equal(await readFile(statePath, "utf8"), before);
    else await assert.rejects(readFile(statePath), { code: "ENOENT" });
    assert.deepEqual(progress, ["Fetching latest production deployment...", "Production deployment resolved.", "Fetching runtime logs...", "Runtime logs received: 1", "Analyzing logs...", "Dry run completed."]);
  });
}

for (const body of ["", "[]", '{"rows":[],"hasMoreRows":false}']) {
  test(`empty logs ${body || "empty body"} finish normally`, async () => {
    assert.deepEqual(await getRuntimeLogs({ ...input, fetcher: async () => new Response(body) }), []);
  });
}

test("invalid historical responses fail instead of silently returning zero logs", async () => {
  for (const body of ["<html>failure</html>", '{"error":"private detail"}', '{"rows":[{"timestamp":"invalid"}]}']) {
    await assert.rejects(getRuntimeLogs({ ...input, fetcher: async () => new Response(body) }), /invalid response/);
  }
});

test("historical page limit fails safely instead of silently dropping older logs", async () => {
  await assert.rejects(getRuntimeLogs({ ...input, fetcher: async () => json({ rows: Array.from({ length: 1000 }, () => entry), hasMoreRows: true }) }), /historical query limit/);
});

test("deployment body timeout covers the period after headers arrive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stream = openStream("application/json", ['{"deployments":']);
  const rejected = assert.rejects(getLatestProductionDeployment(config, async () => stream.response), /Vercel API request timed out/);
  await setImmediate();
  t.mock.timers.tick(20_000);
  await rejected;
  assert.ok(stream.cancelled());
});

test("all historical pages share the same 20-second budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const stream = openStream("application/json");
  const rejected = assert.rejects(getRuntimeLogs({ ...input, fetcher: async () => {
    if (calls++ === 0) {
      t.mock.timers.tick(15_000);
      return json({ rows: [entry], hasMoreRows: true });
    }
    return stream.response;
  } }), /timed out/);
  await setImmediate();
  assert.equal(calls, 2);
  t.mock.timers.tick(5_000);
  await rejected;
  assert.ok(stream.cancelled());
});

test("live read failure leaves state byte-identical and never calls Feishu", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vercel-monitor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  await saveState(statePath, emptyState());
  const before = await readFile(statePath, "utf8");
  let calls = 0;
  await assert.rejects(runMonitor({ config, dryRun: false, statePath, now: NOW, fetcher: async (target) => {
    calls++;
    const path = new URL(String(target)).pathname;
    if (path === "/v6/deployments") return json({ deployments: [{ uid: "dpl_test" }] });
    assert.equal(path, "/api/logs/request-logs");
    throw new DOMException("private", "AbortError");
  } }), /Vercel runtime logs request timed out/);
  assert.equal(calls, 2);
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("SSE multiline data and split frames normalize before parsing", async () => {
  const stream = openStream("text/event-stream", ['data: {"timestamp":\n', `data: ${entry.timestamp}, "message":"one"}\n\ndata: ${JSON.stringify(entry)}\n\ndata: [DO`, 'NE]\n\n']);
  const logs = await getRuntimeLogs({ ...input, fetcher: async () => stream.response });
  assert.equal(logs.length, 2);
  assert.equal(logs[0]?.message, "one");
});

test("historical query excludes timestamps outside since/until", async () => {
  const logs = await getRuntimeLogs({ ...input, fetcher: async () => json([entry, { ...entry, timestamp: input.since - 1 }, { ...entry, timestamp: NOW + 1 }]) });
  assert.equal(logs.length, 1);
});
