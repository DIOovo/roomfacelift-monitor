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
  await runMonitor({ ...(config ? { config } : {}), dryRun, ...(fixturePath ? { fixturePath } : {}), onProgress: (message) => console.log(message), statePath: resolve("data/state.json") });
} catch (error) {
  console.error(redactSecrets(error instanceof Error ? error.message : error));
  process.exitCode = 1;
}

function valueAfter(values: string[], name: string) {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
}
