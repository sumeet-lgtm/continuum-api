# Continuum

Email verification, monitoring, and webhook API for GTM and outbound systems.

Continuum verifies email deliverability through layered checks — syntax, DNS MX, disposable domain detection, role account detection, and safe SMTP probing — returning a structured result with a confidence score. It also monitors email addresses over time and delivers signed webhook payloads when status changes.

---

## Architecture

```
                    ┌──────────────────────────────────────┐
  API caller ──────▶│  Fastify API  (src/server.ts)        │
                    │  auth · rate-limit · 14 routes        │
                    └──────────────┬───────────────────────┘
                                   │
                  ┌────────────────▼─────────────────────┐
                  │  Verification engine (src/engine/)    │
                  │  syntax · domain · MX · disposable    │
                  │  role · SMTP · scorer                 │
                  └────────────────┬─────────────────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          ▼                        ▼                         ▼
  Supabase Postgres          Redis / BullMQ           Supabase Storage
  (all canonical data)       (3 queues)               (CSV upload/export)
          │                        │
          │          ┌─────────────┼──────────────┐
          │          ▼             ▼              ▼
          │    bulkWorker   monitorWorker   webhookWorker
          └─────────────────────────────────────────────▶ External endpoints
```

**Three worker processes** run independently from the API server.

---

## Prerequisites

- Node.js 20+
- Docker + Docker Compose (for local Postgres + Redis)
- Supabase project (free tier works) — for Storage
- Upstash Redis (free tier) — or use local Redis in development

---

## Local setup

```bash
# 1. Clone and install
git clone https://github.com/your-org/continuum.git
cd continuum
npm install

# 2. Copy environment template
cp .env.example .env
# Fill in DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_KEY_SALT

# 3. Start local Postgres + Redis
docker-compose up postgres redis -d

# 4. Run database migrations
npm run db:migrate

# 5. Generate Prisma client
npm run db:generate

# 6. Seed the disposable domain blocklist (~100k domains)
npx tsx scripts/update-disposable-list.ts

# 7. Create your first API key
npm run db:seed -- --label "dev" --rpm 1000
# Copy the cnt_xxx key that is printed — it won't be shown again

# 8. Start the API
npm run dev

# 9. Start workers (separate terminals)
npm run worker:bulk
npm run worker:monitor
npm run worker:webhook
```

The API is available at **http://localhost:3000**.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `development` \| `production` \| `test` |
| `PORT` | No | `3000` | HTTP port |
| `HOST` | No | `0.0.0.0` | Bind address |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string |
| `REDIS_URL` | **Yes** | — | Redis URL (`rediss://default:<token>@<host>:<port>`) |
| `SUPABASE_URL` | **Yes** | — | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | — | Supabase service role key |
| `STORAGE_BUCKET_UPLOADS` | No | `continuum-uploads` | Bucket for CSV uploads |
| `STORAGE_BUCKET_EXPORTS` | No | `continuum-exports` | Bucket for result exports |
| `SMTP_CHECK_ENABLED` | No | `true` | Set `false` on GCP/AWS/Azure VMs (port 25 blocked) |
| `SMTP_CHECK_TIMEOUT_MS` | No | `5000` | SMTP probe timeout |
| `SMTP_HELO_DOMAIN` | No | `localhost` | Domain used in EHLO — use a real domain in production |
| `DEFAULT_RATE_LIMIT_RPM` | No | `1000` | Requests per minute per API key |
| `WEBHOOK_MAX_ATTEMPTS` | No | `5` | Max delivery attempts before permanent failure |
| `WEBHOOK_TIMEOUT_MS` | No | `10000` | Webhook POST timeout |
| `LOG_LEVEL` | No | `info` | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` |
| `API_KEY_SALT` | **Yes** | — | 32+ random chars for key hashing — never reuse across envs |

---

## Database setup

```bash
# Run migrations
npm run db:migrate:deploy   # production
npm run db:migrate          # development (creates migration files)

# Browse data
npm run db:studio
```

**Supabase Storage buckets** (create in Supabase dashboard):
```bash
supabase storage create-bucket continuum-uploads --public=false
supabase storage create-bucket continuum-exports --public=false
```

---

## Creating an API key

```bash
npx tsx scripts/generate-api-key.ts --label "Production" --owner "org_123" --rpm 5000
```

Output includes the `cnt_xxx` key. **Save it immediately — it is not stored and cannot be recovered.**

---

## API reference

All routes except `/health*` require:
```
Authorization: Bearer cnt_your_key_here
# or
X-API-Key: cnt_your_key_here
```

### Verification

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/verify` | Verify a single email |

### Bulk verification

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/bulk-jobs` | Upload CSV, create bulk job |
| `GET` | `/v1/bulk-jobs/:id` | Job status + progress |
| `GET` | `/v1/bulk-jobs/:id/results` | Paginated per-email results |

### Monitoring

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/monitoring` | Register email for monitoring |
| `GET` | `/v1/monitoring` | List monitors (with filters) |
| `GET` | `/v1/monitoring/:id` | Single monitor + recent checks |
| `PATCH` | `/v1/monitoring/:id` | Update interval / reactivate |
| `DELETE` | `/v1/monitoring/:id` | Remove monitor |
| `POST` | `/v1/monitoring/:id/recheck` | Trigger immediate recheck |
| `GET` | `/v1/monitoring/:id/checks` | Paginated check history |

### History

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/history/:email` | Verification history for an email |

### Webhooks

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/webhooks` | Register webhook endpoint |
| `GET` | `/v1/webhooks` | List webhooks |
| `GET` | `/v1/webhooks/:id` | Single webhook |
| `PATCH` | `/v1/webhooks/:id` | Update webhook |
| `DELETE` | `/v1/webhooks/:id` | Remove webhook |
| `POST` | `/v1/webhooks/:id/ping` | Send test delivery |
| `GET` | `/v1/webhooks/:id/deliveries` | Delivery history |
| `GET` | `/v1/webhooks/:id/deliveries/:deliveryId` | Single delivery + HTTP attempts |

### System

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Full health check |
| `GET` | `/health/live` | Kubernetes liveness probe |
| `GET` | `/health/ready` | Kubernetes readiness probe |

---

## Curl examples

Replace `cnt_your_key_here` with your actual API key and `localhost:3000` with your host.

```bash
# ── Health (no auth) ──────────────────────────────────────────────────────────
curl http://localhost:3000/health | jq

# ── Verify a single email ─────────────────────────────────────────────────────
curl -sX POST http://localhost:3000/v1/verify \
  -H "Authorization: Bearer cnt_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com"}' | jq

# ── Verify a disposable email ─────────────────────────────────────────────────
curl -sX POST http://localhost:3000/v1/verify \
  -H "Authorization: Bearer cnt_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{"email":"throwaway@mailinator.com"}' | jq

# ── Upload CSV for bulk verification ──────────────────────────────────────────
curl -sX POST http://localhost:3000/v1/bulk-jobs \
  -H "Authorization: Bearer cnt_your_key_here" \
  -F "file=@/path/to/leads.csv" | jq

# ── Poll bulk job status ──────────────────────────────────────────────────────
curl -s http://localhost:3000/v1/bulk-jobs/JOB_ID \
  -H "Authorization: Bearer cnt_your_key_here" | jq

# ── Get paginated bulk results ────────────────────────────────────────────────
curl -s "http://localhost:3000/v1/bulk-jobs/JOB_ID/results?page=1&limit=100&status=valid" \
  -H "Authorization: Bearer cnt_your_key_here" | jq

# ── Get export CSV download URL ───────────────────────────────────────────────
curl -s "http://localhost:3000/v1/bulk-jobs/JOB_ID/results" \
  -H "Authorization: Bearer cnt_your_key_here" | jq '.exportUrl'

# ── Register email for monitoring ─────────────────────────────────────────────
curl -sX POST http://localhost:3000/v1/monitoring \
  -H "Authorization: Bearer cnt_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{"email":"cto@prospect.com","intervalHours":24,"tags":["tier1"]}' | jq

# ── List monitors (active only, with tag filter) ──────────────────────────────
curl -s "http://localhost:3000/v1/monitoring?isActive=true&tag=tier1" \
  -H "Authorization: Bearer cnt_your_key_here" | jq

# ── Trigger immediate recheck ─────────────────────────────────────────────────
curl -sX POST http://localhost:3000/v1/monitoring/MONITOR_ID/recheck \
  -H "Authorization: Bearer cnt_your_key_here" | jq

# ── Get check history for a monitor ──────────────────────────────────────────
curl -s "http://localhost:3000/v1/monitoring/MONITOR_ID/checks?statusChanged=true" \
  -H "Authorization: Bearer cnt_your_key_here" | jq

# ── Pause a monitor ───────────────────────────────────────────────────────────
curl -sX PATCH http://localhost:3000/v1/monitoring/MONITOR_ID \
  -H "Authorization: Bearer cnt_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{"isActive":false}' | jq

# ── Delete a monitor ──────────────────────────────────────────────────────────
curl -sX DELETE http://localhost:3000/v1/monitoring/MONITOR_ID \
  -H "Authorization: Bearer cnt_your_key_here" | jq

# ── Verification history for an email ────────────────────────────────────────
curl -s "http://localhost:3000/v1/history/alice%40example.com?status=valid" \
  -H "Authorization: Bearer cnt_your_key_here" | jq

# ── History with date range ───────────────────────────────────────────────────
curl -s "http://localhost:3000/v1/history/alice%40example.com?since=2026-01-01T00:00:00.000Z" \
  -H "Authorization: Bearer cnt_your_key_here" | jq

# ── Register a webhook ───────────────────────────────────────────────────────
curl -sX POST http://localhost:3000/v1/webhooks \
  -H "Authorization: Bearer cnt_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "url":"https://your-app.com/webhooks/continuum",
    "events":["verification.completed","email.status_changed","bulk_job.completed"],
    "label":"Production webhook"
  }' | jq
# Save the "secret" from the response — it won't be shown again

# ── List webhooks ─────────────────────────────────────────────────────────────
curl -s http://localhost:3000/v1/webhooks \
  -H "Authorization: Bearer cnt_your_key_here" | jq

# ── Update a webhook (disable) ────────────────────────────────────────────────
curl -sX PATCH http://localhost:3000/v1/webhooks/WEBHOOK_ID \
  -H "Authorization: Bearer cnt_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{"isActive":false}' | jq

# ── Send a test ping ──────────────────────────────────────────────────────────
curl -sX POST http://localhost:3000/v1/webhooks/WEBHOOK_ID/ping \
  -H "Authorization: Bearer cnt_your_key_here" | jq

# ── View delivery history ─────────────────────────────────────────────────────
curl -s "http://localhost:3000/v1/webhooks/WEBHOOK_ID/deliveries?delivered=false" \
  -H "Authorization: Bearer cnt_your_key_here" | jq

# ── View a single delivery with HTTP attempt logs ────────────────────────────
curl -s http://localhost:3000/v1/webhooks/WEBHOOK_ID/deliveries/DELIVERY_ID \
  -H "Authorization: Bearer cnt_your_key_here" | jq

# ── Delete a webhook ─────────────────────────────────────────────────────────
curl -sX DELETE http://localhost:3000/v1/webhooks/WEBHOOK_ID \
  -H "Authorization: Bearer cnt_your_key_here" | jq
```

---

## Webhook delivery

When a subscribed event fires, Continuum POSTs a signed JSON payload to your endpoint.

**Request headers:**
```
Content-Type:              application/json
X-Continuum-Signature:     sha256=<hmac-sha256>
X-Continuum-Event:         verification.completed
X-Continuum-Delivery:      <deliveryId>
X-Continuum-Event-Id:      <eventId>
X-Continuum-Attempt:       1
User-Agent:                Continuum-Webhooks/1.0
```

**Event names (Phase 5):**

| Event | Trigger |
|-------|---------|
| `verification.completed` | Single email verified via `POST /v1/verify` |
| `bulk_job.completed` | Bulk job finished processing |
| `email.status_changed` | Monitored email changed verification status |

Legacy event names (`verification_complete`, `bulk_job_complete`, `monitor_status_change`) are still accepted when subscribing for backwards compatibility.

**Retry schedule** (exponential backoff + ±20% jitter):

| Attempt | Base delay |
|---------|-----------|
| 2 | 30 seconds |
| 3 | 2 minutes |
| 4 | 8 minutes |
| 5 | 34 minutes |
| Final | 2 hours → permanently failed |

Your endpoint should return **any 2xx** within 10 seconds. Enqueue and respond immediately; do not process synchronously.

---

## Webhook signature verification

```typescript
// Node.js / TypeScript
import crypto from 'node:crypto';

function verifySignature(
  secret: string,
  rawBody: string,          // raw request body string — NOT parsed JSON
  signatureHeader: string   // value of X-Continuum-Signature
): boolean {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(signatureHeader, 'utf8')
    );
  } catch { return false; }
}

// Express
app.post('/webhooks/continuum', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['x-continuum-signature'] as string;
  if (!verifySignature(process.env.WEBHOOK_SECRET!, req.body.toString(), sig)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const event = JSON.parse(req.body.toString());
  // handle event.event
  res.json({ received: true });
});
```

```python
# Python
import hmac, hashlib

def verify_signature(secret: str, raw_body: bytes, signature: str) -> bool:
    expected = 'sha256=' + hmac.new(
        secret.encode(), raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)

# FastAPI
from fastapi import FastAPI, Request, HTTPException
app = FastAPI()

@app.post('/webhooks/continuum')
async def handle_webhook(request: Request):
    raw = await request.body()
    sig = request.headers.get('x-continuum-signature', '')
    if not verify_signature(WEBHOOK_SECRET, raw, sig):
        raise HTTPException(status_code=401)
    event = await request.json()
    return {'received': True}
```

**Critical:** Always verify against the **raw request body bytes** before JSON-parsing.

---

## Verification status reference

| Status | Meaning | Safe to send? |
|--------|---------|---------------|
| `valid` | SMTP-confirmed deliverable, no red flags | Yes |
| `invalid` | Syntax error, no MX, or SMTP rejected | No |
| `risky` | Deliverable but high bounce/spam risk | With caution |
| `unknown` | SMTP unavailable or greylisted — indeterminate | Human review |

**Sub-status values:**

| subStatus | Description |
|-----------|-------------|
| `syntax_invalid` | RFC 5321 syntax failure |
| `no_mx_records` | Domain has no MX records |
| `mx_lookup_error` | DNS lookup timed out |
| `smtp_rejected` | Server returned permanent 5xx |
| `smtp_greylisted` | Server returned 4xx (try again later) |
| `smtp_not_checked` | SMTP disabled or skipped |
| `catch_all` | Server accepts all addresses |
| `catch_all_role_account` | Catch-all + role prefix |
| `role_account` | Local part is a functional mailbox (admin, support, etc.) |
| `disposable_domain` | Domain is in the disposable blocklist |
| `disposable_smtp_rejected` | Disposable + SMTP-confirmed dead |

---

## SMTP check caveats

| Scenario | Behaviour |
|----------|-----------|
| Port 25 blocked (GCP, AWS, Azure default) | `smtpChecked: false`, `status: unknown`. Set `SMTP_CHECK_ENABLED=false`. |
| Catch-all servers (Gmail Workspace, etc.) | `isCatchAll: true`, `status: risky`. Cannot confirm the specific address. |
| Greylisting | `greylisted: true`, `status: unknown`. Retry after a few minutes. |
| Rate limiting by MX host | `smtpChecked: false`. Reduce `EMAIL_CONCURRENCY` in bulkWorker. |

---

## Rate limit headers

Every authenticated response includes:
```
X-RateLimit-Limit:     1000
X-RateLimit-Remaining: 847
X-RateLimit-Reset:     1714046460   (Unix timestamp)
```

On limit exceeded:
```json
{ "error": "Too many requests", "code": "RATE_LIMITED", "details": { "retryAfterMs": 45000 } }
```

---

## Development scripts

```bash
npm run dev               # Start API with hot-reload
npm run worker:bulk       # Start bulk verification worker
npm run worker:monitor    # Start monitoring worker (cron every 5m)
npm run worker:webhook    # Start webhook delivery worker

npm run db:migrate        # Create and apply new migration
npm run db:generate       # Regenerate Prisma client
npm run db:studio         # Open Prisma Studio (visual DB browser)
npm run db:seed           # Create an API key

npm test                  # Run full test suite (557 tests)
npm run test:watch        # Watch mode
npm run test:coverage     # Coverage report

npm run typecheck         # TypeScript type check only
npm run lint              # ESLint
npm run build             # Compile to dist/
npm run start             # Run compiled output
```

---

## Docker

**Local development** (Postgres + Redis only, API runs via `npm run dev`):
```bash
docker-compose up postgres redis -d
```

**Full stack** (API + workers + Postgres + Redis):
```bash
# Fill in Supabase vars in .env first
docker-compose up
```

Workers each run as a separate service in `docker-compose.yml`.
