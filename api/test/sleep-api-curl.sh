#!/usr/bin/env bash
# 阶段 1 curl 手工验证脚本（可整段复制运行）。
# 前置：api 目录下 `npx wrangler dev --local --port 8787` 正在运行，
#       且已应用 src/db/schema.sql 与 src/db/sleep_schema.sql。
set -euo pipefail

BASE=${BASE:-http://127.0.0.1:8787}
EMAIL="curl-demo-$(date +%s)@example.com"
uuid_lower() { uuidgen | tr 'A-Z' 'a-z'; }

echo "== 1. register + POST /api/auth/token =="
curl -s -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}" >/dev/null

TOKEN=$(curl -s -X POST "$BASE/api/auth/token" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')
echo "token length: ${#TOKEN}"

echo "== 2. unauthenticated → 401 =="
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/sessions"

echo "== 3. POST /api/events sleep =="
SLEEP_CEID=$(uuid_lower)
curl -s -X POST "$BASE/api/events" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"client_event_id\":\"$SLEEP_CEID\",\"event_type\":\"sleep\",\"occurred_at\":\"2026-10-23T16:00:00.000Z\"}"
echo

echo "== 4. duplicate client_event_id → idempotent 200 =="
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/events" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"client_event_id\":\"$SLEEP_CEID\",\"event_type\":\"sleep\",\"occurred_at\":\"2026-10-23T16:00:00.000Z\"}"

echo "== 5. second sleep while open → 409 SLEEP_ALREADY_OPEN =="
curl -s -X POST "$BASE/api/events" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"client_event_id\":\"$(uuid_lower)\",\"event_type\":\"sleep\",\"occurred_at\":\"2026-10-23T16:30:00.000Z\"}"
echo

echo "== 6. POST /api/events wake → paired session =="
curl -s -X POST "$BASE/api/events" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"client_event_id\":\"$(uuid_lower)\",\"event_type\":\"wake\",\"occurred_at\":\"2026-10-24T00:20:00.000Z\"}"
echo

echo "== 7. backfill session (client-generated ids) =="
SID=$(uuid_lower); OP=$(uuid_lower)
curl -s -X POST "$BASE/api/sessions" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"$SID\",\"client_op_id\":\"$OP\",\"start_at\":\"2026-10-18T15:00:00.000Z\",\"end_at\":\"2026-10-18T22:30:00.000Z\",\"quality\":4}"
echo

echo "== 8. overlapping backfill → 409 SESSION_OVERLAP =="
curl -s -X POST "$BASE/api/sessions" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"$(uuid_lower)\",\"client_op_id\":\"$(uuid_lower)\",\"start_at\":\"2026-10-18T22:00:00.000Z\",\"end_at\":\"2026-10-19T01:00:00.000Z\"}"
echo

echo "== 9. edit with optimistic lock (version 1 → 2) =="
curl -s -X PATCH "$BASE/api/sessions/$SID" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"client_op_id\":\"$(uuid_lower)\",\"base_version\":1,\"quality\":5}"
echo

echo "== 10. stale edit → 409 VERSION_CONFLICT =="
curl -s -X PATCH "$BASE/api/sessions/$SID" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"client_op_id\":\"$(uuid_lower)\",\"base_version\":1,\"quality\":3}"
echo

echo "== 11. incremental pull =="
curl -s "$BASE/api/sessions?limit=100" -H "Authorization: Bearer $TOKEN"
echo

echo "== 12. pending events (expect empty, no warning) =="
curl -s "$BASE/api/events/pending" -H "Authorization: Bearer $TOKEN"
echo

echo "== 13. CORS preflight from https://localhost (Capacitor WebView origin) =="
curl -si -X OPTIONS "$BASE/api/events" \
  -H 'Origin: https://localhost' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type' \
  | grep -i '^access-control-' || true

echo "== 14. revoke token; reuse → 401 =="
curl -s -X DELETE "$BASE/api/auth/token" -H "Authorization: Bearer $TOKEN"
echo
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/sessions" -H "Authorization: Bearer $TOKEN"
