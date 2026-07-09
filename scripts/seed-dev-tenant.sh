#!/usr/bin/env bash
# scripts/seed-dev-tenant.sh
# Seeds a dev tenant into the preview KV namespace for local testing.
#
# Usage:
#   bash scripts/seed-dev-tenant.sh
#
# Uses preview namespace ID directly (--remote against preview is safe).
# Run with: node_modules/.bin/wrangler (never pnpm — Volta/Node v22 issue)

set -e

NAMESPACE_ID="c0b19f5d88de4dce8ba7ffd706704c04"
WRANGLER="node_modules/.bin/wrangler"
TENANT_ID="tenant_dev001"
SLUG="devstore"

echo "Seeding dev tenant: ${TENANT_ID} (slug: ${SLUG})"
echo ""

echo "Cleaning up stale keys..."
$WRANGLER kv key delete --namespace-id "$NAMESPACE_ID" "tenant:subdomain:${SLUG}" 2>/dev/null || true
$WRANGLER kv key delete --namespace-id "$NAMESPACE_ID" "tenant:${TENANT_ID}:meta" 2>/dev/null || true
$WRANGLER kv key delete --namespace-id "$NAMESPACE_ID" "global:tenant_slug:${SLUG}" 2>/dev/null || true

echo "Writing slug index..."
$WRANGLER kv key put --namespace-id "$NAMESPACE_ID" \
  "global:tenant_slug:${SLUG}" "${TENANT_ID}"

echo "Writing tenant meta..."
# Status options:
#   pending_verification  — just paid, email not yet verified
#   pending_onboarding    — email verified, Connect not started
#   pending_connect       — Connect in progress
#   pending_products      — Connect done, no products yet  ← use this to test /admin
#   ready                 — has products, not yet live
#   live                  — fully live
$WRANGLER kv key put --namespace-id "$NAMESPACE_ID" \
  "tenant:${TENANT_ID}:meta" "{
  \"id\": \"${TENANT_ID}\",
  \"slug\": \"${SLUG}\",
  \"displayName\": \"Dev Store\",
  \"stripeCustomerId\": \"cus_test_devstore\",
  \"stripeAccountId\": \"acct_1TpuSuQ89fydqg1h\",
  \"status\": \"pending_products\",
  \"createdAt\": 1735689600000
}"

echo "Writing session for manual curl/browser testing..."
# Browser: set __Host-ss-session=manualtest001 in DevTools on http://localhost:8789
# Curl: --cookie "__Host-ss-session=manualtest001"
$WRANGLER kv key put --namespace-id "$NAMESPACE_ID" \
  "session:manualtest001" "{\"tenantId\":\"${TENANT_ID}\",\"createdAt\":$(date +%s)000}"

echo ""
echo "Done. Dev tenant seeded."
echo ""
echo "  Tenant ID  : ${TENANT_ID}"
echo "  Slug       : ${SLUG}"
echo "  Status     : pending_products (router will allow /admin)"
echo "  Session    : manualtest001  →  __Host-ss-session=manualtest001"
echo ""
echo "Start workers:"
echo "  node_modules/.bin/wrangler dev --port 8787   (from workers/api/)"
echo "  node_modules/.bin/wrangler dev --port 8788   (from workers/webhooks/)"
echo "  node_modules/.bin/wrangler dev --port 8786   (from workers/router/)"
echo "  node_modules/.bin/wrangler pages dev src --port 8789  (from pages/platform/ — platform.headorn.com)"