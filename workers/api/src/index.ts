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
import { requireAuth } from './lib/auth';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    // ── Registration (public, no auth) ────────────────────────────
    if (path === '/register' && method === 'POST') {
      return handleRegister(request, env);
    }

    // ── Auth routes ───────────────────────────────────────────────
    if (path === '/auth/magic-link' && method === 'POST') {
      return handleMagicLink(request, env);
    }

    if (path === '/auth/verify' && method === 'GET') {
      return handleVerify(request, env);
    }

    if (path === '/auth/logout' && method === 'POST') {
      return handleLogout(request, env);
    }

    if (path === '/auth/me' && method === 'GET') {
      return handleMe(request, env);
    }

    // ── Connect routes ────────────────────────────────────────────
    if (path === '/connect/start' && method === 'POST') {
      return handleConnectStart(request, env);
    }
    if (path === '/connect/return' && method === 'GET') {
      return handleConnectReturn(request, env);
    }
    if (path === '/connect/refresh' && method === 'GET') {
      return handleConnectRefresh(request, env);
    }

    // ── Storefront routes (public, no merchant auth) ───────────────
    if (path === '/storefront/checkout' && method === 'POST') {
      return handleStorefrontCheckout(request, env);
    }
    if (path === '/storefront/products' && method === 'GET') {
      return handleStorefrontListProducts(request, env);
    }
    if (path.match(/^\/storefront\/products\/[^/]+$/) && method === 'GET') {
      const productId = path.split('/')[3];
      return handleStorefrontGetProduct(request, env, productId);
    }

    // ── Product routes (all require merchant auth) ─────────────────
    if (path.startsWith('/products')) {
      const session = await requireAuth(request, env);
      if (session instanceof Response) return session;
      const { tenantId } = session;

      if (path === '/products' && method === 'POST') {
        return handleCreateProduct(request, env, tenantId);
      }
      if (path === '/products' && method === 'GET') {
        return handleListProducts(request, env, tenantId);
      }
      if (path.match(/^\/products\/[^/]+$/) && method === 'GET') {
        const productId = path.split('/')[2];
        return handleGetProduct(request, env, tenantId, productId);
      }
      if (path.match(/^\/products\/[^/]+$/) && method === 'PATCH') {
        const productId = path.split('/')[2];
        return handleUpdateProduct(request, env, tenantId, productId);
      }
      if (path.match(/^\/products\/[^/]+$/) && method === 'DELETE') {
        const productId = path.split('/')[2];
        return handleArchiveProduct(request, env, tenantId, productId);
      }
      if (path.match(/^\/products\/[^/]+\/variants\/[^/]+$/) && method === 'PATCH') {
        const parts = path.split('/');
        return handleUpdateVariant(request, env, tenantId, parts[2], parts[4]);
      }
      if (path.match(/^\/products\/[^/]+\/variants\/[^/]+$/) && method === 'DELETE') {
        const parts = path.split('/');
        return handleArchiveVariant(request, env, tenantId, parts[2], parts[4]);
      }
      if (path.match(/^\/products\/[^/]+\/images$/) && method === 'POST') {
        const productId = path.split('/')[2];
        return handleUploadProductImage(request, env, tenantId, productId);
      }
    }

    // ── Order routes (all require merchant auth) ───────────────────
    if (path.startsWith('/orders')) {
      const session = await requireAuth(request, env);
      if (session instanceof Response) return session;
      const { tenantId } = session;

      if (path === '/orders' && method === 'GET') {
        return handleListOrders(request, env, tenantId);
      }
      if (path.match(/^\/orders\/[^/]+$/) && method === 'GET') {
        const orderId = path.split('/')[2];
        return handleGetOrder(request, env, tenantId, orderId);
      }
      if (path.match(/^\/orders\/[^/]+\/status$/) && method === 'PATCH') {
        const orderId = path.split('/')[2];
        return handleUpdateOrderStatus(request, env, tenantId, orderId);
      }
    }

    // ── 404 ───────────────────────────────────────────────────────
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
