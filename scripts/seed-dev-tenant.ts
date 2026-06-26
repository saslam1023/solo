// scripts/seed-dev-tenant.ts
// Run with: npx wrangler kv key put --preview --binding SOLOSTORE_KV ...
// Or run this script: npx tsx scripts/seed-dev-tenant.ts

import { execSync } from "child_process";

const PREVIEW_FLAG = "--preview"; // targets preview_id namespace

// ── Tenant record ──────────────────────────────────────────────────────────
const tenantId = "tenant_dev001";

const tenant = {
  id: tenantId,
  name: "Dev Store",
  subdomain: "devstore",
  customDomain: null,
  stripeAccountId: null,
  stripeOnboarded: false,
  plan: "starter",
  createdAt: new Date().toISOString(),
};

// ── Key helpers (must match packages/shared/src/kv.ts) ────────────────────
const keys = [
  // Resolve by subdomain → tenant ID
  {
    key: `tenant:subdomain:${tenant.subdomain}`,
    value: tenantId,
  },
  // Tenant record itself
  {
    key: `tenant:${tenantId}:meta`,
    value: JSON.stringify(tenant),
  },
];

// ── Write via wrangler CLI ─────────────────────────────────────────────────
for (const { key, value } of keys) {
  const cmd = `npx wrangler kv key put ${PREVIEW_FLAG} --binding SOLOSTORE_KV "${key}" "${value}"`;
  console.log(`Writing: ${key}`);
  execSync(cmd, { stdio: "inherit" });
}

console.log("\n✅ Dev tenant seeded. Subdomain: devstore | ID:", tenantId);