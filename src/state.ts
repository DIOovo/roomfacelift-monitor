import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MonitorState } from "./types.js";

export function emptyState(): MonitorState {
  return { version: 1, lastProcessedTimestamp: 0, recentFingerprints: {}, processedLogIds: {}, pendingAlerts: [] };
}

export async function loadState(path: string) {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<MonitorState>;
    if (value.version !== 1) return emptyState();
    return {
      version: 1 as const,
      lastProcessedTimestamp: Number(value.lastProcessedTimestamp) || 0,
      recentFingerprints: value.recentFingerprints ?? {},
      processedLogIds: value.processedLogIds ?? {},
      pendingAlerts: Array.isArray(value.pendingAlerts) ? value.pendingAlerts : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
}

export async function saveState(path: string, state: MonitorState) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
