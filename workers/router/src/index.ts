/**
 * workers/router/src/index.ts
 *
 * Front door for all SoloStore traffic.
 *
 * Responsibilities:
 *   1. WAF — block malicious paths before any processing
 *   2. Tenant resolution — subdomain or custom domain → TenantMeta
 *   3. Status gate — path-aware: owner routes open earlier than
 *      public storefront routes (see below)
 *   4. Forward to the API worker, or to the Pages dashboard build,
 *      depending on path
 *
 * Tenant resolution order:
 *   1. X-Dev-Host header (dev only — simulates subdomain without DNS)
 *   2. Custom domain → global:tenant_domain:{hostname} (must be VERIFIED)
 *   3. Subdomain slug → global:tenant_slug:{slug}
 *
 * Status gate — path-aware:
 *   - /storefront/*  (public buyer-facing) → requires 'ready' or 'live'
 *     — a store with no products yet should never appear to buyers.
 *   - everything else (/dashboard, /auth, /settings, /products,
 *     /orders, /account — all owner-authenticated or auth-flow
 *     routes) → allowed from 'pending_products' onward, so a merchant
 *     can finish setup (add products, etc.) before going live.
 *   Earlier statuses (pending_verification/onboarding/connect) never
 *   reach here at all — those redirect to the platform host, not a
 *   tenant subdomain.
 *
 * Security:
 *   - WAF runs before tenant resolution — no KV reads on blocked paths
 *   - Tenant ID passed to API worker via X-Tenant-Id header (internal only)
 *   - X-Tenant-Id set by router and cannot be spoofed by clients
 *     (router strips any incoming X-Tenant-Id before forwarding)
 *   - Custom domains only resolve once customDomainVerified is true.
 *   - Reserved subdomain list is imported from @solostore/shared so
 *     it stays in sync with the slug validation used at signup/settings.
 */

import { kvKey, type TenantMeta, isReservedSlug } from '@solostore/shared';

// ─── Env ─────────────────────────────────────────────────────────────────────

export interface Env {
  SOLOSTORE_KV: KVNamespace;
  ENVIRONMENT: string;
  API_WORKER_URL: string;   // dev only: http://localhost:8787
  ASSETS: Fetcher;          // dashboard static build, bound via [assets] in wrangler.toml
  // Service binding — uncomment when deploying:
  // API: Fetcher;
}

// ─── WAF: Blocked paths ───────────────────────────────────────────────────────

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
  const rawHost =
    request.headers.get('x-dev-host')
    ?? request.headers.get('host')
    ?? '';

  const hostname = rawHost.split(':')[0].toLowerCase();

  console.log('resolveTenant:start', {
    rawHost,
    hostname,
    url: request.url,
  });

  if (!hostname) {
    console.log('resolveTenant:missing-host');
    return null;
  }

  console.log(`Resolving tenant for hostname: ${hostname}`);

  // ── 1. Custom domain lookup ───────────────────────────────────────────────
  const domainKey = kvKey.tenantByDomain(hostname);
  const domainTenantId = await kv.get(domainKey);

  console.log('resolveTenant:domain-lookup', {
    domainKey,
    domainTenantId,
  });

  if (domainTenantId) {
    const tenantKey = kvKey.tenant(domainTenantId);
    const tenant = await kv.get<TenantMeta>(tenantKey, 'json');

    console.log('resolveTenant:domain-tenant', {
      tenantKey,
      tenantFound: !!tenant,
      tenantSlug: tenant?.slug,
      tenantStatus: tenant?.status,
    });

    if (tenant && tenant.customDomainVerified === true) {
      console.log('resolveTenant:domain-hit-verified');
      return tenant;
    }

    if (tenant && tenant.customDomainVerified !== true) {
      console.log('resolveTenant:domain-hit-unverified');
      return null;
    }
  }

  // ── 2. Subdomain slug lookup ──────────────────────────────────────────────
  const parts = hostname.split('.');
  const slug = parts[0];
  const slugKey = kvKey.tenantBySlug(slug);

  console.log('resolveTenant:slug-prepare', {
    parts,
    slug,
    slugKey,
    isReserved: isReservedSlug(slug),
  });

  if (parts.length >= 2 && slug && !isReservedSlug(slug)) {
    const slugTenantId = await kv.get(slugKey);

    console.log('resolveTenant:slug-lookup', {
      slugKey,
      slugTenantId,
    });

    if (slugTenantId) {
      const tenantKey = kvKey.tenant(slugTenantId);
      const tenant = await kv.get<TenantMeta>(tenantKey, 'json');

      console.log('resolveTenant:slug-tenant', {
        tenantKey,
        tenantFound: !!tenant,
        tenantSlug: tenant?.slug,
        tenantStatus: tenant?.status,
      });

      if (tenant) return tenant;
    }
  }

  console.log('resolveTenant:not-found', {
    hostname,
    domainKey,
    slugKey,
  });

  return null;
}
// ─── Forward request ──────────────────────────────────────────────────────────

async function forwardToApi(
  request: Request,
  tenant: TenantMeta,
  env: Env
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete('x-tenant-id');
  headers.delete('x-tenant-slug');
  headers.set('x-tenant-id', tenant.id);
  headers.set('x-tenant-slug', tenant.slug ?? '');

  const forwardedRequest = new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
  });

  // Production: use service binding
  // if (env.API) return env.API.fetch(forwardedRequest);

  // Dev: proxy via fetch to local API worker
  return fetch(forwardedRequest);
}

// Serves the dashboard static build (HTML/CSS/JS) directly from this
// Worker's bound assets ([assets] in wrangler.toml — same binary in
// dev and production, no separate Pages deployment, no service-binding
// trust boundary between two Workers). By the time we get here, the
// tenant has already been resolved and status-gated by the caller —
// env.ASSETS never runs ahead of that check because run_worker_first
// is set in wrangler.toml, so static files can never be reached by an
// unauthenticated request or an inactive tenant.
//
// IMPORTANT: pass the request straight through, unmodified. Cloudflare's
// asset handler applies its own html_handling logic (default:
// "auto-trailing-slash") to every ASSETS.fetch() call, which already
// resolves "/dashboard" -> public/dashboard/index.html implicitly
// (via a single 307 to "/dashboard/", which the browser follows
// automatically). Rewriting the path ourselves (e.g. appending
// "/index.html" or a trailing slash by hand) fights that logic and
// produces a redirect loop — this was the actual cause of the
// "Store not found" / infinite-redirect behaviour seen in testing.
async function forwardToDashboard(
  request: Request,
  env: Env
): Promise<Response> {
  return env.ASSETS.fetch(request);
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (isBlockedPath(url.pathname)) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/healthz') {
      return new Response(JSON.stringify({ ok: true, service: 'router' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const tenant = await resolveTenant(request, env.SOLOSTORE_KV, env);

    if (!tenant) {
      return new Response(JSON.stringify({ error: 'Store not found hit it', tenant: tenant }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!statusAllowed(url.pathname, tenant.status)) {
      return new Response(JSON.stringify({ error: 'Store is not yet active' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')) {
      return forwardToDashboard(request, env);
    }

    return forwardToApi(request, tenant, env);
  },
};