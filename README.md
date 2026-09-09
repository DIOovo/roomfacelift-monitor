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

It then starts the pinned `vercel@59.13.1` CLI with an argument array. The command shape is:

```text
vercel logs
  --deployment <resolved deployment>
  --project <VERCEL_PROJECT_ID>
  --scope <VERCEL_TEAM_ID>
  --environment production
  --since <ISO timestamp>
  --until <ISO timestamp>
  --limit 1000
  --json
  --no-follow
  --non-interactive
  --no-color
  --token <VERCEL_TOKEN>
```

These flags were verified against `vercel logs --help` from the pinned CLI. Historical mode is the default; `--follow` is only enabled when explicitly passed. The monitor still supplies `--no-follow` to make the intended mode visible. `--json` produces JSON Lines on stdout. The token is passed only to the child process and the command or complete argv is never logged.

The monitor does not call the undocumented `/api/logs/request-logs` endpoint. If the official CLI cannot read historical logs for the account or token, its sanitized error is reported and the run fails without changing state or falling back to an internal endpoint.

### Request bounds and diagnostics

- Deployment lookup has a 20-second deadline covering headers and the response body.
- The CLI gets 20 seconds. At the deadline the monitor sends `SIGTERM`, waits one second, and sends `SIGKILL` if necessary. The error is `Vercel logs command timed out.`
- Stdout is limited to 16 MiB and stderr to 64 KiB. JSON and NDJSON are parsed only after a successful exit.
- CLI failures retain useful sanitized text such as an HTTP status while removing credentials, project/team identifiers, URLs, emails, UUIDs, cookies, and authorization values.
- Actions prints only safe stages and counts. The final console summary contains counts only, without alert messages or deployment identifiers.
- The workflow remains scheduled every five minutes with `timeout-minutes: 4` as the final safeguard.

The initial query covers the previous ten minutes. Later queries start one second before the last processed timestamp and end at the current run time. Local fixtures also support JSON arrays, `{ logs: [] }`, and `{ data: [] }`.

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
