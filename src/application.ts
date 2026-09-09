import { resolve } from "node:path";
import { hasVercelConfig, readConfig, readFeishuConfig } from "./config.js";
import { sendFeishuAlert } from "./feishu.js";
import { runMonitor } from "./monitor.js";
import type { Alert } from "./types.js";

export async function runApplication(input: {
  args: string[];
  environment: NodeJS.ProcessEnv;
  statePath: string;
  fetcher?: typeof fetch;
  now?: number;
  onLog: (message: string) => void;
  monitorRunner?: typeof runMonitor;
  feishuSender?: typeof sendFeishuAlert;
}) {
  if (input.args.includes("--send-test-alert")) {
    const config = readFeishuConfig(input.environment);
    const alert = selfTestAlert(input.now ?? Date.now());
    input.onLog("Sending Feishu self-test...");
    await (input.feishuSender ?? sendFeishuAlert)({
      webhookUrl: config.feishuWebhookUrl,
      ...(config.feishuWebhookSecret ? { secret: config.feishuWebhookSecret } : {}),
      alert,
      ...(input.fetcher ? { fetcher: input.fetcher } : {}),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    input.onLog("Feishu self-test sent successfully.");
    return;
  }

  const dryRun = input.args.includes("--dry-run");
  const fixtureArg = valueAfter(input.args, "--fixture");
  const fixturePath = fixtureArg
    ? resolve(fixtureArg)
    : dryRun && !hasVercelConfig(input.environment)
      ? resolve("fixtures/runtime-logs.json")
      : undefined;
  const config = fixturePath && dryRun
    ? undefined
    : readConfig(input.environment, { requireFeishu: !dryRun });
  await (input.monitorRunner ?? runMonitor)({
    ...(config ? { config } : {}),
    dryRun,
    ...(fixturePath ? { fixturePath } : {}),
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    ...(input.now === undefined ? {} : { now: input.now }),
    onProgress: input.onLog,
    statePath: input.statePath,
  });
}

function selfTestAlert(time: number): Alert {
  return {
    id: "self-test",
    fingerprint: "monitor-self-test",
    severity: "CRITICAL",
    time,
    route: "/monitor/self-test",
    method: "TEST",
    statusCode: 500,
    summary: "Synthetic monitoring test",
    occurrences: 1,
    requestId: "self-test",
    deploymentId: "self-test",
  };
}

function valueAfter(values: string[], name: string) {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
}
