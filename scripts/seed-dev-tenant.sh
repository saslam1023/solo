#!/usr/bin/env bash
set -e

# Get f71e79c3fcc24c8c8516ddfbc5ed050d from workers/router/wrangler.toml preview_id
f71e79c3fcc24c8c8516ddfbc5ed050d="${1:?Usage: bash scripts/seed-dev-tenant.sh <preview_namespace_id>}"

echo "Deleting stale keys..."
npx wrangler kv key delete --namespace-id "$f71e79c3fcc24c8c8516ddfbc5ed050d" "tenant:subdomain:devstore" 2>/dev/null || true
npx wrangler kv key delete --namespace-id "$f71e79c3fcc24c8c8516ddfbc5ed050d" "tenant:tenant_dev001:meta" 2>/dev/null || true

echo "Writing: global:tenant_slug:devstore"
npx wrangler kv key put --namespace-id "$f71e79c3fcc24c8c8516ddfbc5ed050d" \
  "global:tenant_slug:devstore" "tenant_dev001"

echo "Writing: tenant:tenant_dev001:meta"
npx wrangler kv key put --namespace-id "$f71e79c3fcc24c8c8516ddfbc5ed050d" \
  "tenant:tenant_dev001:meta" '{
  "id": "tenant_dev001",
  "slug": "devstore",
  "name": "Dev Store",
  "plan": "free",
  "createdAt": 1735689600000,
  "active": true
}'

echo ""
echo "✅ Dev tenant seeded correctly."
echo "   Slug key : global:tenant_slug:devstore → tenant_dev001"
echo "   Meta key : tenant:tenant_dev001:meta"
