/* workers/api/src/index.ts */
import { Env } from './types/env';
import {
  handleMagicLink,
  handleVerify,
  handleLogout,
  handleMe,
} from './routes/auth';
import { handleRegister } from './handlers/register';
import {
  handleConnectStart,
  handleConnectReturn,
  handleConnectRefresh,
} from './handlers/connect';
import {
  handleCreateProduct,
  handleListProducts,
  handleGetProduct,
  handleUpdateProduct,
  handleUpdateVariant,
  handleArchiveProduct,
  handleArchiveVariant,
  handleUploadProductImage,
} from './handlers/products';
import {
  handleListOrders,
  handleGetOrder,
  handleUpdateOrderStatus,
} from './handlers/orders';
import { handleStorefrontCheckout } from './handlers/checkout';
import {
  handleStorefrontListProducts,
  handleStorefrontGetProduct,
} from './handlers/storefront';
import {
  handleGetSettings,
  handleUpdateStoreSettings,
  handleUpdateDomainSettings,
  handleDeleteAccount,
} from './handlers/settings';
import { requireAuth } from './lib/auth';

// ─── CORS ──────────────────────────────────────────────────────────────────
//
// The dashboard (Pages, port 8789 in dev) is a different origin from this
// API worker (port 8787 in dev). Because dashboard.js sends credentials
// (the __Host- session cookie via credentials: 'include'), the browser
// requires an explicit, single origin in Access-Control-Allow-Origin —
// a wildcard '*' is rejected by browsers whenever credentials are involved.
//
// ALLOWED_ORIGINS is therefore an explicit allowlist, not a wildcard.
// Add the production dashboard origin here once it exists (e.g.
// https://app.headorn.com) — do NOT widen this to a wildcard or a regex
// that could match attacker-controlled origins.

const ALLOWED_ORIGINS = new Set([
  'http://localhost:8789',
]);

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return {};
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function withCors(response: Response, origin: string | null): Response {
  const headers = corsHeaders(origin);
  if (Object.keys(headers).length === 0) return response;

  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    const origin = request.headers.get('Origin');

    // ── CORS preflight ─────────────────────────────────────────────
    // Browsers send OPTIONS before any cross-origin request that carries
    // credentials or non-simple headers (Content-Type: application/json
    // triggers this). Must be handled before any auth/route logic.
    if (method === 'OPTIONS') {
      const headers = corsHeaders(origin);
      if (Object.keys(headers).length === 0) {
        // Origin not on the allowlist — no CORS headers, browser will
        // block the actual request. Still return 204 rather than an
        // error; we don't want to leak info about valid vs invalid origins.
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204, headers });
    }

    const respond = (response: Response) => withCors(response, origin);

    // ── Registration (public, no auth) ────────────────────────────
    if (path === '/register' && method === 'POST') {
      return respond(await handleRegister(request, env));
    }

    // ── Auth routes ───────────────────────────────────────────────
    if (path === '/auth/magic-link' && method === 'POST') {
      return respond(await handleMagicLink(request, env));
    }

    if (path === '/auth/verify' && method === 'GET') {
      return respond(await handleVerify(request, env));
    }

    if (path === '/auth/logout' && method === 'POST') {
      return respond(await handleLogout(request, env));
    }

    if (path === '/auth/me' && method === 'GET') {
      return respond(await handleMe(request, env));
    }

    // ── Connect routes ────────────────────────────────────────────
    if (path === '/connect/start' && method === 'POST') {
      return respond(await handleConnectStart(request, env));
    }
    if (path === '/connect/return' && method === 'GET') {
      return respond(await handleConnectReturn(request, env));
    }
    if (path === '/connect/refresh' && method === 'GET') {
      return respond(await handleConnectRefresh(request, env));
    }

    // ── Storefront routes (public, no merchant auth) ───────────────
    if (path === '/storefront/checkout' && method === 'POST') {
      return respond(await handleStorefrontCheckout(request, env));
    }
    if (path === '/storefront/products' && method === 'GET') {
      return respond(await handleStorefrontListProducts(request, env));
    }
    if (path.match(/^\/storefront\/products\/[^/]+$/) && method === 'GET') {
      const productId = path.split('/')[3];
      return respond(await handleStorefrontGetProduct(request, env, productId));
    }

    // ── Product routes (all require merchant auth) ─────────────────
    if (path.startsWith('/products')) {
      const session = await requireAuth(request, env);
      if (session instanceof Response) return respond(session);
      const { tenantId } = session;

      if (path === '/products' && method === 'POST') {
        return respond(await handleCreateProduct(request, env, tenantId));
      }
      if (path === '/products' && method === 'GET') {
        return respond(await handleListProducts(request, env, tenantId));
      }
      if (path.match(/^\/products\/[^/]+$/) && method === 'GET') {
        const productId = path.split('/')[2];
        return respond(await handleGetProduct(request, env, tenantId, productId));
      }
      if (path.match(/^\/products\/[^/]+$/) && method === 'PATCH') {
        const productId = path.split('/')[2];
        return respond(await handleUpdateProduct(request, env, tenantId, productId));
      }
      if (path.match(/^\/products\/[^/]+$/) && method === 'DELETE') {
        const productId = path.split('/')[2];
        return respond(await handleArchiveProduct(request, env, tenantId, productId));
      }
      if (path.match(/^\/products\/[^/]+\/variants\/[^/]+$/) && method === 'PATCH') {
        const parts = path.split('/');
        return respond(await handleUpdateVariant(request, env, tenantId, parts[2], parts[4]));
      }
      if (path.match(/^\/products\/[^/]+\/variants\/[^/]+$/) && method === 'DELETE') {
        const parts = path.split('/');
        return respond(await handleArchiveVariant(request, env, tenantId, parts[2], parts[4]));
      }
      if (path.match(/^\/products\/[^/]+\/images$/) && method === 'POST') {
        const productId = path.split('/')[2];
        return respond(await handleUploadProductImage(request, env, tenantId, productId));
      }
    }

    // ── Order routes (all require merchant auth) ───────────────────
    if (path.startsWith('/orders')) {
      const session = await requireAuth(request, env);
      if (session instanceof Response) return respond(session);
      const { tenantId } = session;

      if (path === '/orders' && method === 'GET') {
        return respond(await handleListOrders(request, env, tenantId));
      }
      if (path.match(/^\/orders\/[^/]+$/) && method === 'GET') {
        const orderId = path.split('/')[2];
        return respond(await handleGetOrder(request, env, tenantId, orderId));
      }
      if (path.match(/^\/orders\/[^/]+\/status$/) && method === 'PATCH') {
        const orderId = path.split('/')[2];
        return respond(await handleUpdateOrderStatus(request, env, tenantId, orderId));
      }
    }

    // ── Settings routes (all require merchant auth) ─────────────────
    if (path.startsWith('/settings')) {
      const session = await requireAuth(request, env);
      if (session instanceof Response) return respond(session);
      const { tenantId } = session;

      if (path === '/settings' && method === 'GET') {
        return respond(await handleGetSettings(request, env, tenantId));
      }
      if (path === '/settings/store' && method === 'PATCH') {
        return respond(await handleUpdateStoreSettings(request, env, tenantId));
      }
      if (path === '/settings/domain' && method === 'PATCH') {
        return respond(await handleUpdateDomainSettings(request, env, tenantId));
      }
    }

    // ── Account routes (requires merchant auth) ──────────────────────
    if (path === '/account' && method === 'DELETE') {
      const session = await requireAuth(request, env);
      if (session instanceof Response) return respond(session);
      const { tenantId } = session;
      return respond(await handleDeleteAccount(request, env, tenantId));
    }

    // ── 404 ───────────────────────────────────────────────────────
    return respond(new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }));
  },
};