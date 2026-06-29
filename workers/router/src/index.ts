/**
 * workers/router/src/index.ts
 *
 * Front door for all SoloStore traffic.
 *
 * Responsibilities:
 *   1. WAF — block malicious paths before any processing
 *   2. Tenant resolution — subdomain or custom domain → TenantMeta
 *   3. Status gate — only 'ready' or 'live' tenants serve traffic
 *   4. Forward to API worker via service binding (prod) or fetch (dev)
 *
 * What the router does NOT do:
 *   - Session validation (API worker owns auth)
 *   - Business logic (API worker owns that)
 *   - Store PII (GDPR-minimal — only reads KV for tenant resolution)
 *
 * Tenant resolution order:
 *   1. X-Dev-Host header (dev only — simulates subdomain without DNS)
 *   2. Custom domain → global:tenant_domain:{hostname}
 *   3. Subdomain slug → global:tenant_slug:{slug}
 *
 * Security:
 *   - WAF runs before tenant resolution — no KV reads on blocked paths
 *   - Tenant ID passed to API worker via X-Tenant-Id header (internal only)
 *   - X-Tenant-Id set by router and cannot be spoofed by clients
 *     (router strips any incoming X-Tenant-Id before forwarding)
 */

import { kvKey, type TenantMeta } from '@solostore/shared';

// ─── Env ─────────────────────────────────────────────────────────────────────

export interface Env {
  SOLOSTORE_KV: KVNamespace;
  ENVIRONMENT: string;
  API_WORKER_URL: string;   // dev only: http://localhost:8787
  // Service binding — uncomment when deploying:
  // API: Fetcher;
}

// ─── WAF: Blocked paths ───────────────────────────────────────────────────────
//
// Block common attack patterns before any processing.
// Returns 404 for all blocked paths — don't leak that we detected the attack.

const BLOCKED_PATH_PATTERNS = [
  /^\/\.env/,
  /^\/wp-/,
  /^\/phpmyadmin/,
  /^\/admin\.php/,
  /^\/xmlrpc\.php/,
  /\.\.(\/|\\)/,        // path traversal
  /^\/etc\//,           // unix file access
  /^\/proc\//,          // process info
  /\0/,                 // null byte injection
  /^\/\.git/,           // git exposure
  /^\/\.ssh/,           // ssh key exposure
];

function isBlockedPath(pathname: string): boolean {
  return BLOCKED_PATH_PATTERNS.some(p => p.test(pathname));
}

// ─── Tenant resolution ───────────────────────────────────────────────────────

async function resolveTenant(
  request: Request,
  kv: KVNamespace,
  env: Env
): Promise<TenantMeta | null> {
  // In dev, X-Dev-Host simulates a subdomain without real DNS.
  // Strip port from host header.
  const rawHost = request.headers.get('x-dev-host')
    ?? request.headers.get('host')
    ?? '';
  const hostname = rawHost.split(':')[0].toLowerCase();

  if (!hostname) return null;

  // ── 1. Custom domain lookup ───────────────────────────────────────────────
  const domainTenantId = await kv.get(kvKey.tenantByDomain(hostname));
  if (domainTenantId) {
    const tenant = await kv.get<TenantMeta>(kvKey.tenant(domainTenantId), 'json');
    if (tenant) return tenant;
  }

  // ── 2. Subdomain slug lookup ──────────────────────────────────────────────
  // e.g. testshop5.headorn.com → slug = testshop5
  const parts = hostname.split('.');
  const slug = parts[0];

  // Must have at least two parts and not be a reserved subdomain
  const reserved = ['www', 'app', 'api', 'admin', 'mail', 'ftp'];
  if (parts.length >= 2 && slug && !reserved.includes(slug)) {
    const slugTenantId = await kv.get(kvKey.tenantBySlug(slug));
    if (slugTenantId) {
      const tenant = await kv.get<TenantMeta>(kvKey.tenant(slugTenantId), 'json');
      if (tenant) return tenant;
    }
  }

  return null;
}

// ─── Forward request ──────────────────────────────────────────────────────────

async function forwardToApi(
  request: Request,
  tenant: TenantMeta,
  env: Env
): Promise<Response> {
  // Strip any client-supplied X-Tenant-* headers — prevent spoofing
  const headers = new Headers(request.headers);
  headers.delete('x-tenant-id');
  headers.delete('x-tenant-slug');

  // Attach verified tenant context for API worker
  headers.set('x-tenant-id', tenant.id);
  headers.set('x-tenant-slug', tenant.slug ?? '');

  const forwardedRequest = new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
  });

  // Production: use service binding (zero latency, no egress cost)
  // if (env.API) return env.API.fetch(forwardedRequest);

  // Dev: proxy via fetch to local API worker
  return fetch(forwardedRequest);
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── WAF — runs before everything, no KV reads ─────────────────────────
    if (isBlockedPath(url.pathname)) {
      // Return 404 not 403 — don't confirm the path exists
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Health check — no tenant required ─────────────────────────────────
    if (url.pathname === '/healthz') {
      return new Response(JSON.stringify({ ok: true, service: 'router' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Tenant resolution ─────────────────────────────────────────────────
    const tenant = await resolveTenant(request, env.SOLOSTORE_KV, env);

    if (!tenant) {
      return new Response(JSON.stringify({ error: 'Store not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Status gate ───────────────────────────────────────────────────────
    // Only serve traffic for tenants that have completed setup
    const activeStatuses = ['ready', 'live'];
    if (!activeStatuses.includes(tenant.status)) {
      return new Response(JSON.stringify({ error: 'Store is not yet active' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Forward to API worker ─────────────────────────────────────────────
    return forwardToApi(request, tenant, env);
  },
};
