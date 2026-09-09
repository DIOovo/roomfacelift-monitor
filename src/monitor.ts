import { readFile } from "node:fs/promises";
import { analyzeLogs } from "./analyze.js";
import { sendFeishuAlert } from "./feishu.js";
import { redactSecrets } from "./redact.js";
import { loadState, saveState } from "./state.js";
import type { MonitorConfig, RuntimeLog } from "./types.js";
import { getLatestProductionDeployment, getRuntimeLogs, parseRuntimeLogs } from "./vercel.js";

const DEFAULT_LOOKBACK_MS = 10 * 60 * 1000;

export async function runMonitor(input: {
  config?: MonitorConfig;
  dryRun: boolean;
  fixturePath?: string;
  statePath: string;
  now?: number;
  fetcher?: typeof fetch;
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
      deploymentId = await getLatestProductionDeployment(input.config, input.fetcher);
      const since = Math.max(0, (originalState.lastProcessedTimestamp || now - DEFAULT_LOOKBACK_MS) - 1000);
      logs = await getRuntimeLogs({ config: input.config, deploymentId, since, until: now, ...(input.fetcher ? { fetcher: input.fetcher } : {}) });
    }
  } catch (error) {
    throw new Error(`Monitor could not read Vercel logs safely: ${redactSecrets(error instanceof Error ? error.message : error)}`);
  }

  const productionLogs = logs.filter((log) => log.environment === "production").map((log) => ({ ...log, deploymentId: log.deploymentId || deploymentId }));
  const { state, alerts } = analyzeLogs(productionLogs, originalState, now);
  if (input.dryRun) return { deploymentId, logsRead: productionLogs.length, alerts, statePersisted: false };
  if (!input.config) throw new Error("Feishu configuration is required outside dry-run mode.");

  await saveState(input.statePath, state);
  for (const alert of [...state.pendingAlerts]) {
    await sendFeishuAlert({ webhookUrl: input.config.feishuWebhookUrl, ...(input.config.feishuWebhookSecret ? { secret: input.config.feishuWebhookSecret } : {}), alert, ...(input.fetcher ? { fetcher: input.fetcher } : {}) });
    state.pendingAlerts = state.pendingAlerts.filter((item) => item.id !== alert.id);
    await saveState(input.statePath, state);
  }
  return { deploymentId, logsRead: productionLogs.length, alerts, statePersisted: true };
}
