import { resolve } from "node:path";
import { hasVercelConfig, readConfig } from "./config.js";
import { redactSecrets } from "./redact.js";
import { runMonitor } from "./monitor.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const fixtureArg = valueAfter(args, "--fixture");
const fixturePath = fixtureArg ? resolve(fixtureArg) : dryRun && !hasVercelConfig() ? resolve("fixtures/runtime-logs.json") : undefined;

try {
  const config = fixturePath && dryRun ? undefined : readConfig(process.env, { requireFeishu: !dryRun });
  const result = await runMonitor({ ...(config ? { config } : {}), dryRun, ...(fixturePath ? { fixturePath } : {}), statePath: resolve("data/state.json") });
  console.log(JSON.stringify({ mode: dryRun ? "dry-run" : "live", source: fixturePath ? "fixture" : "vercel", deploymentId: result.deploymentId, logsRead: result.logsRead, alerts: result.alerts.map(({ severity, route, statusCode, summary, occurrences }) => ({ severity, route, statusCode, summary: redactSecrets(summary), occurrences })), statePersisted: result.statePersisted }, null, 2));
} catch (error) {
  console.error(redactSecrets(error instanceof Error ? error.message : error));
  process.exitCode = 1;
}

function valueAfter(values: string[], name: string) {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
}
