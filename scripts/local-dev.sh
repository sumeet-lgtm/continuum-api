#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Continuum — local development launcher
# Usage: bash scripts/local-dev.sh
#
# Starts:  local Postgres + Redis (via docker-compose)
#          API server (tsx watch)
#          All 3 workers
# All in one terminal with colour-coded output.
# Press Ctrl+C to stop everything cleanly.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
NC='\033[0m'

die()  { echo -e "${RED}✗ $1${NC}"; exit 1; }
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
step() { echo -e "\n${BOLD}▶ $1${NC}"; }

command -v docker >/dev/null 2>&1 || die "Docker not found. Install Docker Desktop from https://docker.com"
command -v npx   >/dev/null 2>&1 || die "npx not found. Install Node.js 20+"

# ─── Check .env ───────────────────────────────────────────────────────────────

if [ ! -f .env ]; then
  die ".env not found. Run: bash scripts/setup.sh first"
fi

# Load .env
set -o allexport
# shellcheck disable=SC1091
source .env
set +o allexport

# Override DATABASE_URL for local Postgres
export DATABASE_URL="postgresql://continuum:continuum@localhost:5432/continuum"
export REDIS_URL="redis://localhost:6379"
export NODE_ENV="development"
export LOG_LEVEL="debug"

step "Starting local Postgres + Redis"
docker-compose up postgres redis -d 2>/dev/null || \
  docker compose up postgres redis -d

# Wait for Postgres
echo -n "   Waiting for Postgres..."
for i in $(seq 1 30); do
  if docker-compose exec -T postgres pg_isready -U continuum >/dev/null 2>&1 || \
     docker compose exec -T postgres pg_isready -U continuum >/dev/null 2>&1; then
    echo " ready"
    break
  fi
  echo -n "."
  sleep 1
done
ok "Postgres + Redis running"

step "Running database migrations on local Postgres"
npx prisma migrate deploy 2>&1 | grep -E "Applied|No pending|Error" | head -5 || true
ok "Migrations applied"

step "Seeding disposable domain list (if empty)"
if [ ! -s data/disposable-domains.txt ] || [ "$(wc -l < data/disposable-domains.txt)" -lt 10 ]; then
  npx tsx scripts/update-disposable-list.ts 2>/dev/null && ok "Blocklist seeded" || \
    echo "   Using bundled seed (network unavailable)"
fi

# ─── Launch all processes in parallel ────────────────────────────────────────

step "Starting API + workers"
echo ""

# Colour-prefixed log wrapper
prefix() {
  local COLOUR="$1"
  local LABEL="$2"
  while IFS= read -r line; do
    echo -e "${COLOUR}[${LABEL}]${NC} $line"
  done
}

# Start all 4 processes, prefix their output
(npx tsx watch src/server.ts 2>&1 | prefix "$GREEN" "API    ") &
PID_API=$!

sleep 2  # Let API start before workers connect to Redis

(npx tsx src/workers/bulkWorker.ts 2>&1    | prefix "$BLUE"    "BULK   ") &
PID_BULK=$!

(npx tsx src/workers/monitorWorker.ts 2>&1 | prefix "$CYAN"    "MONITOR") &
PID_MON=$!

(npx tsx src/workers/webhookWorker.ts 2>&1 | prefix "$MAGENTA" "WEBHOOK") &
PID_WH=$!

echo ""
echo -e "${BOLD}All services running. Press Ctrl+C to stop.${NC}"
echo ""
echo -e "  API:     ${GREEN}http://localhost:3000${NC}"
echo -e "  Health:  ${GREEN}http://localhost:3000/health${NC}"
echo ""

# ─── Cleanup on exit ─────────────────────────────────────────────────────────

cleanup() {
  echo ""
  echo "Stopping all services..."
  kill "$PID_API" "$PID_BULK" "$PID_MON" "$PID_WH" 2>/dev/null || true
  docker-compose stop postgres redis 2>/dev/null || docker compose stop postgres redis 2>/dev/null || true
  echo "Done."
}

trap cleanup INT TERM EXIT

# Wait for any process to exit
wait "$PID_API" "$PID_BULK" "$PID_MON" "$PID_WH"
