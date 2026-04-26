#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Continuum — smoke test
# Usage: bash scripts/smoke-test.sh [BASE_URL] [API_KEY]
#
# Tests every major endpoint and prints a pass/fail table.
# If BASE_URL and API_KEY are not passed, reads them from .env / prompts.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
RESULTS=()

pass() { PASS=$((PASS+1)); RESULTS+=("${GREEN}PASS${NC}  $1"); }
fail() { FAIL=$((FAIL+1)); RESULTS+=("${RED}FAIL${NC}  $1 — $2"); }

# ─── Resolve BASE_URL and API_KEY ────────────────────────────────────────────

BASE_URL="${1:-}"
API_KEY="${2:-}"

if [ -z "$BASE_URL" ]; then
  if [ -f .env ]; then source .env 2>/dev/null || true; fi
  read -rp "Enter BASE_URL (e.g. https://api.yourdomain.com or http://localhost:3000): " BASE_URL
fi

BASE_URL="${BASE_URL%/}"  # strip trailing slash

if [ -z "$API_KEY" ]; then
  read -rsp "Enter API key (cnt_xxx): " API_KEY
  echo ""
fi

echo ""
echo -e "${BOLD}Running smoke tests against ${BASE_URL}${NC}"
echo ""

# ─── Helper ───────────────────────────────────────────────────────────────────

check() {
  local LABEL="$1"
  local EXPECTED_STATUS="$2"
  local METHOD="$3"
  local PATH="$4"
  local DATA="${5:-}"
  local EXTRA_FLAGS="${6:-}"

  local FLAGS=(-s -o /dev/null -w "%{http_code}" -X "$METHOD" "${BASE_URL}${PATH}")
  FLAGS+=(-H "Authorization: Bearer ${API_KEY}")

  if [ -n "$DATA" ]; then
    FLAGS+=(-H "Content-Type: application/json" -d "$DATA")
  fi

  # shellcheck disable=SC2206
  if [ -n "$EXTRA_FLAGS" ]; then
    read -ra EXTRA <<< "$EXTRA_FLAGS"
    FLAGS+=("${EXTRA[@]}")
  fi

  local STATUS
  STATUS=$(curl "${FLAGS[@]}" 2>/dev/null || echo "000")

  if [ "$STATUS" == "$EXPECTED_STATUS" ]; then
    pass "$LABEL (HTTP $STATUS)"
  else
    fail "$LABEL" "expected $EXPECTED_STATUS got $STATUS"
  fi
}

# ─── Tests ───────────────────────────────────────────────────────────────────

# System
check "GET /health (no auth)"               "200" GET "/health"
check "GET /health/live"                    "200" GET "/health/live" "" "" "-H 'Authorization:'"
check "GET / root info"                     "200" GET "/" "" "" "-H 'Authorization:'"

# Auth
check "POST /v1/verify — no key → 401"     "401" POST "/v1/verify" '{"email":"x@x.com"}' \
  "-H 'Authorization:' -H 'Content-Type: application/json'"

# Verify
check "POST /v1/verify — valid email"       "200" POST "/v1/verify" \
  '{"email":"test@example.com"}'
check "POST /v1/verify — bad syntax → 200 invalid" "200" POST "/v1/verify" \
  '{"email":"notanemail"}'
check "POST /v1/verify — disposable"        "200" POST "/v1/verify" \
  '{"email":"test@mailinator.com"}'
check "POST /v1/verify — role account"      "200" POST "/v1/verify" \
  '{"email":"admin@example.com"}'
check "POST /v1/verify — missing body → 400" "400" POST "/v1/verify" '{}'

# Bulk jobs
check "GET /v1/bulk-jobs/nonexistent → 404" "404" GET "/v1/bulk-jobs/nonexistent"

# Monitoring
check "GET /v1/monitoring"                  "200" GET "/v1/monitoring"
check "POST /v1/monitoring — bad interval → 422" "422" POST "/v1/monitoring" \
  '{"email":"x@example.com","intervalHours":7}'
check "DELETE /v1/monitoring/nonexistent → 404" "404" DELETE "/v1/monitoring/nonexistent"

# History
check "GET /v1/history/alice%40example.com" "200" GET "/v1/history/alice%40example.com"
check "GET /v1/history/invalid → 422"      "422" GET "/v1/history/notanemail"

# Webhooks
check "GET /v1/webhooks"                   "200" GET "/v1/webhooks"
check "POST /v1/webhooks — http url → 422" "422" POST "/v1/webhooks" \
  '{"url":"http://example.com","events":["verification.completed"]}'
check "POST /v1/webhooks — bad event → 422" "422" POST "/v1/webhooks" \
  '{"url":"https://example.com","events":["made_up_event"]}'
check "DELETE /v1/webhooks/nonexistent → 404" "404" DELETE "/v1/webhooks/nonexistent"

# Verify response shape
VERIFY_RESP=$(curl -s -X POST "${BASE_URL}/v1/verify" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}' 2>/dev/null)

if echo "$VERIFY_RESP" | grep -q '"status"'; then
  pass "POST /v1/verify — response has 'status' field"
else
  fail "POST /v1/verify — response shape" "no 'status' field found"
fi

if echo "$VERIFY_RESP" | grep -q '"score"'; then
  pass "POST /v1/verify — response has 'score' field"
else
  fail "POST /v1/verify — response shape" "no 'score' field found"
fi

if echo "$VERIFY_RESP" | grep -q '"greylisted"'; then
  pass "POST /v1/verify — checks.greylisted present"
else
  fail "POST /v1/verify — checks.greylisted" "missing from response"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
for R in "${RESULTS[@]}"; do
  echo -e "  $R"
done
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}All ${TOTAL} tests passed.${NC}"
  exit 0
else
  echo -e "${RED}${BOLD}${FAIL}/${TOTAL} tests failed.${NC}"
  echo ""
  echo "Common causes:"
  echo "  - API not running yet (check Railway dashboard / logs)"
  echo "  - Wrong API key (re-run: npx tsx scripts/generate-api-key.ts)"
  echo "  - Database migrations not applied (re-run: npm run db:migrate:deploy)"
  exit 1
fi
