import { errorResponse, jsonResponse } from '@solostore/shared';

export interface Env {
  KV: KVNamespace;
  R2: R2Bucket;
  SESSION_SECRET: string;
  STRIPE_SECRET_KEY: string;
  RESEND_API_KEY: string;
  ENVIRONMENT: string;
}

// ─── requireAuth ──────────────────────────────────────────────────────────────
//
// The router Worker validates the session and injects X-Tenant-Id + X-User-Id.
// This guard just ensures those headers are present — i.e. the request came
// through the router and passed auth. Direct calls without these headers are
// rejected, which also blocks any bypass attempts.

function requireAuth(request: Request): { tenantId: string; userId: string } | Response {
  const tenantId = request.headers.get('X-Tenant-Id');
  const userId = request.headers.get('X-User-Id');
  if (!tenantId || !userId) {
    return errorResponse('Unauthorized', 401);
  }
  return { tenantId, userId };
}

// ─── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    // Public endpoints (no auth required)
    if (url.pathname === '/healthz') {
      return jsonResponse({ ok: true, service: 'api' });
    }

    // ── Protected routes ──
    if (url.pathname.startsWith('/api/')) {
      const auth = requireAuth(request);
      if (auth instanceof Response) return auth;
      const { tenantId, userId } = auth;

      // Products
      if (url.pathname === '/api/products' && method === 'GET') {
        return handleListProducts(tenantId, env);
      }

      // Orders
      if (url.pathname === '/api/orders' && method === 'GET') {
        return handleListOrders(tenantId, env);
      }

      // Fallthrough
      return errorResponse('Not found', 404);
    }

    return errorResponse('Not found', 404);
  },
};

// ─── Handlers (stubs — fully implemented in Phase 3+) ────────────────────────

async function handleListProducts(tenantId: string, env: Env): Promise<Response> {
  // Phase 3: full KV list + pagination
  return jsonResponse({ tenantId, products: [], message: 'Phase 3 implementation pending' });
}

async function handleListOrders(tenantId: string, env: Env): Promise<Response> {
  // Phase 4: full KV list + pagination
  return jsonResponse({ tenantId, orders: [], message: 'Phase 4 implementation pending' });
}