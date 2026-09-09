import { createHmac } from "node:crypto";
import { redactSecrets } from "./redact.js";
import type { Alert } from "./types.js";

export async function sendFeishuAlert(input: { webhookUrl: string; secret?: string; alert: Alert; fetcher?: typeof fetch; now?: number }) {
  const payload = buildFeishuPayload(input.alert, input.secret, input.now);
  const response = await (input.fetcher ?? fetch)(input.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const result = parseObject(text);
  const code = typeof result?.code === "number" ? result.code : typeof result?.StatusCode === "number" ? result.StatusCode : null;
  if (!response.ok || (code !== null && code !== 0)) throw new Error(`Feishu webhook failed (${response.status}): ${safeMessage(result)}`);
}

export function buildFeishuPayload(alert: Alert, secret?: string, now = Date.now()) {
  const severityIcon = alert.severity === "CRITICAL" ? "🔴" : alert.severity === "ERROR" ? "🟠" : "🟡";
  const body: Record<string, unknown> = {
    msg_type: "interactive",
    card: {
      header: { template: alert.severity === "CRITICAL" ? "red" : alert.severity === "ERROR" ? "orange" : "yellow", title: { tag: "plain_text", content: `${severityIcon} RoomFacelift Production Error` } },
      elements: [
        { tag: "markdown", content: `**Severity:** ${alert.severity}\n**Time:** ${new Date(alert.time).toISOString()}\n**Method:** ${safe(alert.method)}\n**Route:** ${safe(alert.route)}\n**Status:** ${alert.statusCode ?? "unknown"}\n**Error:** ${safe(alert.summary)}\n**Occurrences:** ${alert.occurrences}\n**Request ID:** ${safe(alert.requestId)}\n**Deployment ID:** ${safe(alert.deploymentId)}` },
      ],
    },
  };
  if (secret) {
    const timestamp = Math.floor(now / 1000).toString();
    const sign = createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
    body.timestamp = timestamp;
    body.sign = sign;
  }
  return body;
}

function safe(value: string) { return redactSecrets(value).replace(/[<>]/g, ""); }
function parseObject(text: string) { try { const value = JSON.parse(text) as unknown; return typeof value === "object" && value !== null ? value as Record<string, unknown> : null; } catch { return null; } }
function safeMessage(value: Record<string, unknown> | null) { return redactSecrets(value?.msg ?? value?.StatusMessage ?? "Request failed").slice(0, 200); }
