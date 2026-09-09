# RoomFacelift Production Error Monitor

A small, read-only monitor that runs every five minutes in GitHub Actions:

`GitHub Actions → Vercel production deployment → runtime logs → filtering/redaction → five-minute aggregation → Feishu custom bot`

It never changes the RoomFacelift deployment and never sends request bodies or customer data to Feishu.

## Setup

### 1. Create a Vercel access token

Create a token in **Vercel → Account Settings → Tokens**. Give it access only to the account or team that owns RoomFacelift. Vercel API requests use `Authorization: Bearer <token>`; see the [Vercel REST API overview](https://vercel.com/docs/rest-api).

### 2. Find the Project ID and Team ID

Open the RoomFacelift project in Vercel and copy **Project ID** from **Settings → General**. Copy the team ID from the team settings. If the local RoomFacelift checkout is linked to Vercel, `.vercel/project.json` also contains `projectId` and `orgId`; `orgId` is the value used for `VERCEL_TEAM_ID`.

The monitor first requests the latest production deployment with:

```text
GET https://api.vercel.com/v6/deployments
    ?projectId=<VERCEL_PROJECT_ID>
    &teamId=<VERCEL_TEAM_ID>
    &target=production
    &limit=1
```

It then reads only that deployment's production logs using:

```text
GET https://vercel.com/api/logs/request-logs
    ?projectId=<VERCEL_PROJECT_ID>
    &ownerId=<VERCEL_TEAM_ID>
    &deploymentId=<resolved deployment>
    &environment=production
    &startDate=<last processed timestamp, milliseconds>
    &endDate=<now, milliseconds>
    &page=0
```

This is the finite historical JSON endpoint used by the [official Vercel CLI implementation](https://github.com/vercel/vercel/blob/main/packages/cli/src/util/logs-v2.ts), returning `{ rows, hasMoreRows }`. It is not a separately documented public REST API contract; account access and future compatibility must be confirmed by an authenticated Actions dry-run. The monitor follows pages within a total 20-second logs budget and caps the historical query at 1,000 records. If more pages remain at the cap, it fails without advancing state. Nested request messages are preserved, including error messages after the first entry.

The previous `/v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs` endpoint [returns a stream](https://github.com/vercel/sdk/blob/main/docs/sdks/logs/README.md). Its [SDK request](https://github.com/vercel/sdk/blob/main/src/funcs/logsGetRuntimeLogs.ts) uses `application/stream+json` and does not declare `since`, `until`, `limit`, or `environment` query parameters. Adding those parameters did not establish a finite historical query. The previous unbounded `response.text()` could therefore wait until the workflow killed the job.

### Request bounds and diagnostics

- Deployment lookup has a 20-second deadline covering headers and the response body. All historical pages share a separate 20-second deadline, so every page has at most 20 seconds remaining.
- Requests accept JSON/NDJSON, without advertising SSE. All bodies use a reader, with a 16 MiB per-response size cap.
- Unexpected NDJSON, `application/stream+json`, and SSE responses have a 12-second read deadline and a 5-second idle deadline. EOF or `[DONE]` completes the response. Reaching 1,000 records without completion, timeout, or invalid data fails safely instead of persisting a partial window.
- Every early exit cancels the reader; request completion/failure aborts the controller and clears timers. Reader cancellation itself is never awaited indefinitely.
- `AbortError` and `TimeoutError` become `Monitor could not read Vercel logs safely: Vercel runtime logs request timed out.` Network errors and HTTP failures expose only fixed messages and status codes, never raw response bodies or URLs.
- Actions prints deployment lookup, logs lookup, received count, analysis, and dry-run completion stages. The final console summary contains counts only, without alert messages or deployment identifiers.
- The workflow remains scheduled every five minutes with `timeout-minutes: 4` as the final safeguard.

Vercel documents retention limits in [Runtime Logs](https://vercel.com/docs/logs/runtime). Local fixtures also support JSON arrays, `{ logs: [] }`, and `{ data: [] }`.

### 3. Create a Feishu custom bot

In the target Feishu group, open **Settings → Bots → Add Bot → Custom Bot**. Copy its webhook URL. Enable signature verification if available and copy the signing secret. The [Feishu webhook bot guide](https://open.feishu.cn/community/articles/7271149634339422210?lang=zh-CN) describes the group setup.

Do not paste either value into source files or commit them.

### 4. Add GitHub Actions secrets

In the monitor repository, open **Settings → Secrets and variables → Actions** and add:

| Secret | Required | Purpose |
| --- | --- | --- |
| `VERCEL_TOKEN` | Yes | Read-only Vercel API authentication |
| `VERCEL_PROJECT_ID` | Yes | RoomFacelift project |
| `VERCEL_TEAM_ID` | Yes | Owning Vercel team/account |
| `FEISHU_WEBHOOK_URL` | Yes | Target custom bot webhook |
| `FEISHU_WEBHOOK_SECRET` | No | Feishu signature verification |

Use `.env.example` only as a variable list. Never create or commit an environment file containing live secrets.

## Local use

Install and validate:

```bash
npm install
npm test
npm run lint
npm run typecheck
npm run build
```

Fixture dry-run (automatically selected when Vercel credentials are absent):

```bash
npm run monitor -- --dry-run
```

Explicit fixture:

```bash
npm run monitor -- --dry-run --fixture fixtures/runtime-logs.json
```

With Vercel variables present, `--dry-run` reads real logs but never calls Feishu and never updates `data/state.json`.

To test Feishu deliberately, configure all variables and run `npm run monitor` against a controlled test bot. There is no command that sends a synthetic message accidentally; a live run sends only alerts detected in Vercel production logs.

## Alert rules

- **🔴 CRITICAL:** payment webhook/fulfillment failures, `/api/generate` 5xx, generation failures, watermark failures, and service unavailability.
- **🟠 ERROR:** other 5xx/fatal/error logs, unexpected 4xx on critical routes, 413, storage failures, provider failures, and known RoomFacelift failure strings.
- **🟡 WARNING:** repeated abnormal 401, 403, or 429 events. A single expected auth, allowlist, or rate-limit response is ignored; ten identical events in one polling window trigger a warning.

The critical routes are `/api/generate`, `/api/room-image`, `/api/uploads/room-image`, Waffo checkout/webhook, Stripe routes, and `/auth/callback`. Preview logs are discarded even if the API returns them.

## Deduplication and state

The fingerprint is SHA-256 of normalized `route + statusCode + redacted error message`. The first occurrence alerts immediately. Identical occurrences are aggregated for five minutes; a continuing fingerprint produces a new summary with the accumulated count. Log IDs (or a stable fallback hash) prevent replay.

Local state is written atomically to `data/state.json` with mode `0600`. GitHub Actions restores the newest cache with the `roomfacelift-monitor-state-` prefix and saves a new cache after every run. A one-second query overlap plus processed log IDs avoids boundary loss.

Before Feishu delivery, new alerts are persisted in `pendingAlerts`. Each alert is removed only after Feishu confirms success. If Feishu fails, the workflow fails but the cached pending alert remains for the next run. GitHub cache is intentionally lightweight and best-effort; for strict long-term durability, replace the state adapter with an external KV without changing detection logic.

## Security

Every outgoing summary passes through `redactSecrets()`. It removes authorization values, bearer tokens, cookies, API/private keys, JWTs, Supabase/Waffo tokens, signed URL query secrets, email addresses, and UUID-like identifiers. Messages are capped in length. The monitor never includes request bodies, payment data, image URLs, cookies, or user identifiers in Feishu cards.

Vercel and Feishu API errors are sanitized before reaching console output. Secrets are read only from environment variables.

## GitHub Actions and pausing

`.github/workflows/monitor.yml` runs every five minutes and supports manual `workflow_dispatch` with a dry-run checkbox. Scheduled workflows may start a few minutes late during GitHub load.

To pause monitoring, disable the workflow from the repository's **Actions** page. To resume it, enable the workflow again. Do not delete secrets merely to pause: missing credentials correctly make the workflow fail.
