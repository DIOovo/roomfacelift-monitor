import type { MonitorConfig } from "./types.js";

const REQUIRED = ["VERCEL_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID", "FEISHU_WEBHOOK_URL"] as const;

export function readConfig(
  environment: NodeJS.ProcessEnv = process.env,
  options: { requireFeishu?: boolean } = {},
): MonitorConfig {
  const required = options.requireFeishu === false ? REQUIRED.slice(0, 3) : REQUIRED;
  const missing = required.filter((key) => !environment[key]?.trim());
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  const secret = environment.FEISHU_WEBHOOK_SECRET?.trim();
  return {
    vercelToken: environment.VERCEL_TOKEN!.trim(),
    vercelProjectId: environment.VERCEL_PROJECT_ID!.trim(),
    vercelTeamId: environment.VERCEL_TEAM_ID!.trim(),
    feishuWebhookUrl: environment.FEISHU_WEBHOOK_URL?.trim() || "https://unused.invalid/dry-run",
    ...(secret ? { feishuWebhookSecret: secret } : {}),
  };
}

export function hasVercelConfig(environment: NodeJS.ProcessEnv = process.env) {
  return ["VERCEL_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID"].every((key) => Boolean(environment[key]?.trim()));
}
