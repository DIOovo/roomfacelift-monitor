import { readFile } from "node:fs/promises";
import { analyzeLogs } from "./analyze.js";
import { sendFeishuAlert } from "./feishu.js";
import { redactSecrets } from "./redact.js";
import { loadState, saveState } from "./state.js";
import type { MonitorConfig, RuntimeLog } from "./types.js";
import { getLatestProductionDeployment, getRuntimeLogs, parseRuntimeLogs } from "./vercel.js";
import type { VercelLogsRunner } from "./vercel.js";

const DEFAULT_LOOKBACK_MS = 10 * 60 * 1000;

export async function runMonitor(input: {
  config?: MonitorConfig;
  dryRun: boolean;
  fixturePath?: string;
  statePath: string;
  now?: number;
  fetcher?: typeof fetch;
  vercelLogsRunner?: VercelLogsRunner;
  onProgress?: (message: string) => void;
}) {
  const now = input.now ?? Date.now();
  const originalState = await loadState(input.statePath);
  let deploymentId = "fixture";
  let logs: RuntimeLog[];

  try {
    if (input.fixturePath) {
      logs = parseRuntimeLogs(await readFile(input.fixturePath, "utf8"), deploymentId);
    } else {
      if (!input.config) throw new Error("Vercel configuration is required when no fixture is selected.");
      input.onProgress?.("Resolving production deployment...");
      deploymentId = await getLatestProductionDeployment(input.config, input.fetcher);
      input.onProgress?.("Production deployment resolved.");
      const since = Math.max(0, originalState.lastProcessedTimestamp
        ? originalState.lastProcessedTimestamp - 1000
        : now - DEFAULT_LOOKBACK_MS);
      input.onProgress?.("Fetching runtime logs with Vercel CLI...");
      logs = await getRuntimeLogs({ config: input.config, deploymentId, since, until: now, ...(input.vercelLogsRunner ? { runner: input.vercelLogsRunner } : {}) });
    }
  } catch (error) {
    throw new Error(`Monitor could not read Vercel logs safely: ${redactSecrets(error instanceof Error ? error.message : error)}`);
  }

  input.onProgress?.(`Runtime logs received: ${logs.length}`);
  input.onProgress?.("Analyzing logs...");
  const productionLogs = logs.filter((log) => log.environment === "production").map((log) => ({ ...log, deploymentId: log.deploymentId || deploymentId }));
  const { state, alerts } = analyzeLogs(productionLogs, originalState, now);
  input.onProgress?.(`Alerts detected: ${alerts.length}`);
  if (input.dryRun) {
    input.onProgress?.("Dry run completed.");
    return { deploymentId, logsRead: productionLogs.length, alerts, statePersisted: false };
  }
  if (!input.config) throw new Error("Feishu configuration is required outside dry-run mode.");

  await saveState(input.statePath, state);
  for (const alert of [...state.pendingAlerts]) {
    await sendFeishuAlert({ webhookUrl: input.config.feishuWebhookUrl, ...(input.config.feishuWebhookSecret ? { secret: input.config.feishuWebhookSecret } : {}), alert, ...(input.fetcher ? { fetcher: input.fetcher } : {}) });
    state.pendingAlerts = state.pendingAlerts.filter((item) => item.id !== alert.id);
    await saveState(input.statePath, state);
  }
  return { deploymentId, logsRead: productionLogs.length, alerts, statePersisted: true };
}
