import { parseSessionCookie, Session, Tenant, kvKey, errorResponse, jsonResponse } from '@solostore/shared';

export interface Env {
  SOLOSTORE_KV: KVNamespace;
  SESSION_SECRET: string;
  ENVIRONMENT: string;
  // Service bindings — added when api worker exists
  // API: Fetcher;
}

// ─── WAF: Blocked paths ───────────────────────────────────────────────────────

const BLOCKED_PATH_PATTERNS = [
  /^\/\.env/,
  /^\/wp-/,
  /^\/phpmyadmin/,
  /^\/admin\.php/,
  /^\/xmlrpc\.php/,
  /\.\.(\/|\\)/,   // path traversal
];

function isBlockedPath(pathname: string): boolean {
  return BLOCKED_PATH_PATTERNS.some(p => p.test(pathname));
}

// ─── Tenant resolution ───────────────────────────────────────────────────────
//
// Resolution order:
//   1. Custom domain   → global:tenant_domain:{host}
//   2. Subdomain slug  → global:tenant_slug:{slug}

async function resolveTenant(request: Request, kv: KVNamespace): Promise<Tenant | null> {
  const host = request.headers.get('host') ?? '';
  const devHost = request.headers.get('x-dev-host');
  const hostname = (devHost ?? host).split(':')[0];

 

  // Try custom domain first
  const domainTenantId = await kv.get(kvKey.tenantByDomain(hostname)) as string | null;

  if (domainTenantId) {
    const tenant = await kv.get(kvKey.tenant(domainTenantId), 'json') as Tenant | null;
    if (tenant) return tenant;
  }

  // Try subdomain slug
  const parts = hostname.split('.');
  const slug = parts[0];
 

  if (parts.length >= 2 && slug && slug !== 'www' && slug !== 'app') {
    const slugKey = kvKey.tenantBySlug(slug);
   
    const slugTenantId = await kv.get(slugKey) as string | null;
   

    if (slugTenantId) {
      const metaKey = kvKey.tenant(slugTenantId);
   
      const tenant = await kv.get(metaKey, 'json') as Tenant | null;
    
      if (tenant) return tenant;
    }
  }

  return null;
}

// ─── Auth: validate session ───────────────────────────────────────────────────

async function getSession(request: Request, tenantId: string, kv: KVNamespace): Promise<Session | null> {
  const cookieHeader = request.headers.get('cookie');
  const sessionId = parseSessionCookie(cookieHeader);
  if (!sessionId) return null;

  const session = await kv.get(kvKey.session(tenantId, sessionId), 'json') as Session | null;
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    // Expired — clean up lazily
    await kv.delete(kvKey.session(tenantId, sessionId));
    return null;
  }
  return session;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── WAF ──
    if (isBlockedPath(url.pathname)) {
      return new Response('Not Found', { status: 404 });
    }

    // ── Health check (no tenant required) ──
    if (url.pathname === '/healthz') {
      return jsonResponse({ ok: true, service: 'router' });
    }

    // ── Resolve tenant ──
    const tenant = await resolveTenant(request, env.SOLOSTORE_KV);
    if (!tenant) {
      return errorResponse('Store not found', 404);
    }
    if (!tenant.active) {
      return errorResponse('Store is inactive', 403);
    }

    // ── Attach tenant context to forwarded request ──
    const forwardedHeaders = new Headers(request.headers);
    forwardedHeaders.set('X-Tenant-Id', tenant.id);
    forwardedHeaders.set('X-Tenant-Slug', tenant.slug);

    // ── Attach session context if present ──
    const session = await getSession(request, tenant.id, env.SOLOSTORE_KV);
    if (session) {
      forwardedHeaders.set('X-Session-Id', session.sessionId);
      forwardedHeaders.set('X-User-Id', session.userId);
      forwardedHeaders.set('X-User-Role', 'authenticated'); // role fetched in api worker
    }

    // ── Forward to API worker ──
    // Until service binding is wired, proxy via fetch (dev only)
    // When deployed: env.API.fetch(...)
    const proxiedRequest = new Request(request.url, {
      method: request.method,
      headers: forwardedHeaders,
      body: request.body,
    });

    // Placeholder: in Phase 2 this becomes a service binding call
    return jsonResponse({
      message: 'Router OK — tenant resolved',
      tenant: tenant.slug,
      path: url.pathname,
      authenticated: !!session,
    });
  },
};