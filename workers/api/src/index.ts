/* workers/api/src/index.ts */
import { Env } from './types/env';
import {
  handleMagicLink,
  handleVerify,
  handleLogout,
  handleMe,
} from './routes/auth';
import { handleRegister, handleCheckSlug } from './handlers/register';
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

// ── CORS ──────────────────────────────────────────────────────────────────────
// Origins allowed to make credentialed requests (cookies) to the API.
// Storefront pages (buyer-facing) don't need credentials so aren't listed here —
// only dashboard origins that send the session cookie need to be in this list.

const ALLOWED_ORIGINS = new Set([
  'https://headorn.com',
  'https://api.headorn.com',
  'http://localhost:8787', 
  'http://localhost:8788', 
  'http://localhost:8789',          // platform.headorn.com dev server
  'http://localhost:8786',          // Router dev
  'https://platform.headorn.com',   // Platform — signup, /onboarding, /dashboard
  // Tenant subdomains (newstore.headorn.com/admin) handled dynamically below
]);

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  // Allow any *.headorn.com subdomain (merchant /admin)
  const allowed =
    origin &&
    (ALLOWED_ORIGINS.has(origin) ||
      (env.ENVIRONMENT === 'production'
        ? /^https:\/\/[a-z0-9-]+\.headorn\.com$/.test(origin)
        : /^http:\/\/[a-z0-9-]+\.localhost(:\d+)?$/.test(origin)));

  return allowed
    ? {
        'Access-Control-Allow-Origin': origin!,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Cookie',
        'Vary': 'Origin',
      }
    : {};
}

function withCors(response: Response, origin: string | null, env: Env): Response {
  const headers = new Headers(response.headers);
  const cors = corsHeaders(origin, env);
  for (const [k, v] of Object.entries(cors)) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    const origin = request.headers.get('origin');

    // ── Preflight ─────────────────────────────────────────────────────────
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, env),
      });
    }

    let response: Response;

    // ── Registration (public) ─────────────────────────────────────────────
    if (path === '/register/check-slug' && method === 'GET') {
      response = await handleCheckSlug(request, env);
    } else if (path === '/register' && method === 'POST') {
      response = await handleRegister(request, env);

    // ── Auth ──────────────────────────────────────────────────────────────
    } else if (path === '/auth/magic-link' && method === 'POST') {
      response = await handleMagicLink(request, env);
    } else if (path === '/auth/verify' && method === 'GET') {
      response = await handleVerify(request, env);
    } else if (path === '/auth/logout' && method === 'POST') {
      response = await handleLogout(request, env);
    } else if (path === '/auth/me' && method === 'GET') {
      response = await handleMe(request, env);

    // ── Connect ───────────────────────────────────────────────────────────
    } else if (path === '/connect/start' && method === 'POST') {
      response = await handleConnectStart(request, env);
    } else if (path === '/connect/return' && method === 'GET') {
      response = await handleConnectReturn(request, env);
    } else if (path === '/connect/refresh' && method === 'GET') {
      response = await handleConnectRefresh(request, env);

    // ── Storefront (public, no merchant auth) ─────────────────────────────
    } else if (path === '/storefront/checkout' && method === 'POST') {
      response = await handleStorefrontCheckout(request, env);
    } else if (path === '/storefront/products' && method === 'GET') {
      response = await handleStorefrontListProducts(request, env);
    } else if (path.match(/^\/storefront\/products\/[^/]+$/) && method === 'GET') {
      const productId = path.split('/')[3];
      response = await handleStorefrontGetProduct(request, env, productId);

    // ── Products (merchant auth required) ────────────────────────────────
    } else if (path.startsWith('/products')) {
      const session = await requireAuth(request, env);
      if (session instanceof Response) {
        response = session;
      } else {
        const { tenantId } = session;
        if (path === '/products' && method === 'POST') {
          response = await handleCreateProduct(request, env, tenantId);
        } else if (path === '/products' && method === 'GET') {
          response = await handleListProducts(request, env, tenantId);
        } else if (path.match(/^\/products\/[^/]+$/) && method === 'GET') {
          response = await handleGetProduct(request, env, tenantId, path.split('/')[2]);
        } else if (path.match(/^\/products\/[^/]+$/) && method === 'PATCH') {
          response = await handleUpdateProduct(request, env, tenantId, path.split('/')[2]);
        } else if (path.match(/^\/products\/[^/]+$/) && method === 'DELETE') {
          response = await handleArchiveProduct(request, env, tenantId, path.split('/')[2]);
        } else if (path.match(/^\/products\/[^/]+\/variants\/[^/]+$/) && method === 'PATCH') {
          const parts = path.split('/');
          response = await handleUpdateVariant(request, env, tenantId, parts[2], parts[4]);
        } else if (path.match(/^\/products\/[^/]+\/variants\/[^/]+$/) && method === 'DELETE') {
          const parts = path.split('/');
          response = await handleArchiveVariant(request, env, tenantId, parts[2], parts[4]);
        } else if (path.match(/^\/products\/[^/]+\/images$/) && method === 'POST') {
          response = await handleUploadProductImage(request, env, tenantId, path.split('/')[2]);
        } else {
          response = new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
      }

    // ── Orders (merchant auth required) ──────────────────────────────────
    } else if (path.startsWith('/orders')) {
      const session = await requireAuth(request, env);
      if (session instanceof Response) {
        response = session;
      } else {
        const { tenantId } = session;
        if (path === '/orders' && method === 'GET') {
          response = await handleListOrders(request, env, tenantId);
        } else if (path.match(/^\/orders\/[^/]+$/) && method === 'GET') {
          response = await handleGetOrder(request, env, tenantId, path.split('/')[2]);
        } else if (path.match(/^\/orders\/[^/]+\/status$/) && method === 'PATCH') {
          response = await handleUpdateOrderStatus(request, env, tenantId, path.split('/')[2]);
        } else {
          response = new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
      }

    // ── Settings (merchant auth required) ────────────────────────────────
    } else if (path.startsWith('/settings')) {
      const session = await requireAuth(request, env);
      if (session instanceof Response) {
        response = session;
      } else {
        const { tenantId } = session;
        if (path === '/settings' && method === 'GET') {
          response = await handleGetSettings(request, env, tenantId);
        } else if (path === '/settings/store' && method === 'PATCH') {
          response = await handleUpdateStoreSettings(request, env, tenantId);
        } else if (path === '/settings/domain' && method === 'PATCH') {
          response = await handleUpdateDomainSettings(request, env, tenantId);
        } else {
          response = new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
      }

    // ── Account (merchant auth required) ─────────────────────────────────
    } else if (path === '/account' && method === 'DELETE') {
      const session = await requireAuth(request, env);
      if (session instanceof Response) {
        response = session;
      } else {
        response = await handleDeleteAccount(request, env, session.tenantId);
      }

    // ── 404 ───────────────────────────────────────────────────────────────
    } else {
      response = new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return withCors(response, origin, env);
  },
};