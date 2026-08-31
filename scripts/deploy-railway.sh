#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Continuum — Railway deploy script
# Usage: bash scripts/deploy-railway.sh
#
# Requires:
#   - railway CLI installed and logged in  (npm install -g @railway/cli)
#   - .env file created by scripts/setup.sh
#   - railway project initialised  (railway init)
#
# Creates 5 Railway services from the same repo:
#   api            - Fastify API server
#   worker-bulk    - CSV bulk verification
#   worker-monitor - Email monitoring cron
#   worker-webhook - Webhook delivery
#   worker-send    - Scheduled send delivery
#
# Note: this script is the source of truth for what's deployed. If a service
# is running in Railway that isn't listed here (check `railway status` /
# the Railway dashboard), either add it here or tear it down — don't let
# the two drift apart again.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'
RED='\033[0;31m'

ok()   { echo -e "   ${GREEN}✓ $1${NC}"; }
step() { echo -e "\n${GREEN}▶ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠  $1${NC}"; }
die()  { echo -e "${RED}✗ $1${NC}"; exit 1; }
info() { echo -e "   ${BLUE}$1${NC}"; }

command -v railway >/dev/null 2>&1 || \
  die "Railway CLI not found. Run: npm install -g @railway/cli && railway login"

[ -f .env ] || die ".env not found. Run: bash scripts/setup.sh first"

# ─── Load .env ────────────────────────────────────────────────────────────────

step "Loading .env"
set -o allexport
# shellcheck disable=SC1091
source .env
set +o allexport
ok ".env loaded"

# ─── Set Railway env vars ────────────────────────────────────────────────────

step "Pushing environment variables to Railway"
info "This sets all vars project-wide so every service inherits them."

ENV_VARS=(
  "NODE_ENV=production"
  "DATABASE_URL=${DATABASE_URL}"
  "REDIS_URL=${REDIS_URL}"
  "SUPABASE_URL=${SUPABASE_URL}"
  "SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}"
  "STORAGE_BUCKET_UPLOADS=continuum-uploads"
  "STORAGE_BUCKET_EXPORTS=continuum-exports"
  "SMTP_CHECK_ENABLED=${SMTP_CHECK_ENABLED:-false}"
  "SMTP_CHECK_TIMEOUT_MS=5000"
  "SMTP_HELO_DOMAIN=${SMTP_HELO_DOMAIN:-localhost}"
  "DEFAULT_RATE_LIMIT_RPM=1000"
  "WEBHOOK_MAX_ATTEMPTS=5"
  "WEBHOOK_TIMEOUT_MS=10000"
  "LOG_LEVEL=info"
  "API_KEY_SALT=${API_KEY_SALT}"
  # Required in production — config.ts refuses to start without every one
  # of these set to a real value (see .env.example for what each guards).
  "DOMAIN_KEY_SECRET=${DOMAIN_KEY_SECRET}"
  "UNSUBSCRIBE_SECRET=${UNSUBSCRIBE_SECRET}"
  "TRACKING_SECRET=${TRACKING_SECRET}"
  "MAILBOX_CREDS_SECRET=${MAILBOX_CREDS_SECRET}"
  "OPTIN_SECRET=${OPTIN_SECRET}"
  "SESSION_SECRET=${SESSION_SECRET}"
)

for VAR in "${ENV_VARS[@]}"; do
  railway variables set "$VAR" --silent 2>/dev/null || \
    railway variables set "$VAR" 2>&1 | grep -v "^$" | head -1
done

ok "Environment variables pushed"

# ─── Deploy services ──────────────────────────────────────────────────────────

step "Deploying API service"
railway up \
  --service api \
  --detach \
  -- bash -c "npm run build && node dist/server.js" \
  2>/dev/null || {
    info "Creating service 'api'..."
    railway service create api 2>/dev/null || true
    railway up --service api --detach 2>&1 | tail -3
  }
ok "API service deployed"

step "Deploying bulk worker"
railway service create worker-bulk 2>/dev/null || true
railway variables set --service worker-bulk "START_CMD=node dist/workers/bulkWorker.js" --silent 2>/dev/null || true
railway up --service worker-bulk --detach 2>&1 | tail -3
ok "Bulk worker deployed"

step "Deploying monitor worker"
railway service create worker-monitor 2>/dev/null || true
railway up --service worker-monitor --detach 2>&1 | tail -3
ok "Monitor worker deployed"

step "Deploying webhook worker"
railway service create worker-webhook 2>/dev/null || true
railway up --service worker-webhook --detach 2>&1 | tail -3
ok "Webhook worker deployed"

step "Deploying send worker"
railway service create worker-send 2>/dev/null || true
railway variables set --service worker-send "START_CMD=node dist/workers/sendWorker.js" --silent 2>/dev/null || true
railway up --service worker-send --detach 2>&1 | tail -3
ok "Send worker deployed"

# ─── Get public URL ───────────────────────────────────────────────────────────

step "Fetching API URL"
sleep 3
API_URL=$(railway domain --service api 2>/dev/null || echo "")

if [ -n "$API_URL" ]; then
  ok "API live at: https://${API_URL}"
  
  echo ""
  echo -e "${BOLD}Test your deployment:${NC}"
  echo ""
  echo "  curl https://${API_URL}/health | jq"
  echo ""
  echo "  # Then grab your API key from the setup script output and:"
  echo "  curl -X POST https://${API_URL}/v1/verify \\"
  echo "    -H 'Authorization: Bearer cnt_YOUR_KEY' \\"
  echo "    -H 'Content-Type: application/json' \\"
  echo "    -d '{\"email\":\"test@example.com\"}' | jq"
else
  warn "Could not auto-detect URL. Check Railway dashboard for your API domain."
fi

echo ""
echo -e "${GREEN}${BOLD}All 4 services deployed to Railway.${NC}"
echo ""
