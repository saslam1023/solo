#!/usr/bin/env bash
set -e

CONFIG="--config workers/router/wrangler.toml"
BINDING="--preview --binding SOLOSTORE_KV"

echo "Writing: tenant:subdomain:devstore"
npx wrangler kv key put $BINDING "tenant:subdomain:devstore" "tenant_dev001" $CONFIG

echo "Writing: tenant:tenant_dev001:meta"
npx wrangler kv key put $BINDING "tenant:tenant_dev001:meta" '{
  "id": "tenant_dev001",
  "name": "Dev Store",
  "subdomain": "devstore",
  "customDomain": null,
  "stripeAccountId": null,
  "stripeOnboarded": false,
  "plan": "starter",
  "createdAt": "2025-01-01T00:00:00.000Z"
}' $CONFIG

echo ""
echo "✅ Dev tenant seeded. Subdomain: devstore | ID: tenant_dev001"
