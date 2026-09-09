export type Severity = "CRITICAL" | "ERROR" | "WARNING";

export type RuntimeLog = {
  id?: string;
  timestamp: number;
  deploymentId?: string;
  environment?: string;
  level?: string;
  message?: string;
  method?: string;
  route?: string;
  path?: string;
  requestPath?: string;
  requestId?: string;
  status?: number;
  statusCode?: number;
  [key: string]: unknown;
};

export type Alert = {
  id: string;
  fingerprint: string;
  severity: Severity;
  time: number;
  method: string;
  route: string;
  statusCode: number | null;
  summary: string;
  occurrences: number;
  requestId: string;
  deploymentId: string;
};

export type FingerprintState = {
  firstSeen: number;
  lastSeen: number;
  lastAlerted: number;
  count: number;
  alertedCount: number;
};

export type MonitorState = {
  version: 1;
  lastProcessedTimestamp: number;
  recentFingerprints: Record<string, FingerprintState>;
  processedLogIds: Record<string, number>;
  pendingAlerts: Alert[];
};

export type MonitorConfig = {
  vercelToken: string;
  vercelProjectId: string;
  vercelTeamId: string;
  feishuWebhookUrl: string;
  feishuWebhookSecret?: string;
};
