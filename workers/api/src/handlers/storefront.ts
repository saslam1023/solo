/* workers/api/src/handlers/storefront.ts */

/**
 * Public storefront API — no merchant auth required.
 *
 * Routes:
 *   GET /storefront/products          List active products for a tenant
 *   GET /storefront/products/:id      Get single active product
 *
 * Tenant resolution order:
 *   1. X-Tenant-Id header (set by router worker in production)
 *   2. ?slug= query param (dev and direct API access)
 *   3. X-Dev-Host header subdomain (dev subdomain simulation)
 *   4. Host header subdomain (production subdomain)
 *
 * Security:
 *   - No merchant session required
 *   - Internal fields stripped from all responses (stripeProductId,
 *     stripePriceId, tenantId on variants)
 *   - Archived products and variants never returned
 *   - Stock levels hidden by default — opt-in via ?showStock=true
 *   - Tenant resolution never exposes whether a tenant exists if not active
 */

import { kvKey, type TenantMeta } from '@solostore/shared';
import type { Product, ProductVariant } from './products';
import type { Env } from '../types/env';

// ─── Public-safe response types ───────────────────────────────────────────────
// Internal Stripe IDs and tenant context stripped before sending to buyers.

interface PublicVariant {
  id: string;
  sku?: string;
  colour?: string;
  size?: string;
  weightG?: number;
  stock?: number;          // only included if showStock=true
  pricePence: number;
  currency: 'gbp';
}

interface PublicProduct {
  id: string;
  name: string;
  description: string;
  type: 'physical' | 'digital';
  materials?: string[];
  tags?: string[];
  imageUrls: string[];
  variants: PublicVariant[];
  currency: 'gbp';
  createdAt: number;
  updatedAt: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitiseVariant(variant: ProductVariant, showStock: boolean): PublicVariant {
  return {
    id: variant.id,
    sku: variant.sku,
    colour: variant.colour,
    size: variant.size,
    weightG: variant.weightG,
    ...(showStock ? { stock: variant.stock } : {}),
    pricePence: variant.pricePence,
    currency: 'gbp',
  };
}

function sanitiseProduct(product: Product, showStock: boolean): PublicProduct {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    type: product.type,
    materials: product.materials,
    tags: product.tags,
    imageUrls: product.imageUrls,
    // Strip archived variants entirely
    variants: product.variants
      .filter(v => v.status === 'active')
      .map(v => sanitiseVariant(v, showStock)),
    currency: product.currency,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

/**
 * Resolve tenantId from request.
 *
 * Priority:
 *   1. X-Tenant-Id header — set by router worker, most trusted
 *   2. ?slug= query param — dev and direct API access
 *   3. X-Dev-Host subdomain — dev subdomain simulation
 *   4. Host subdomain — production
 *
 * Returns tenantId string or null if unresolvable.
 */
async function resolveTenantId(
  request: Request,
  url: URL,
  env: Env
): Promise<string | null> {
  // 1. Router has already resolved — use it directly
  const headerTenantId = request.headers.get('x-tenant-id');
  if (headerTenantId) return headerTenantId;

  // 2. Explicit slug query param
  const slugParam = url.searchParams.get('slug');
  if (slugParam) {
    const tenantId = await env.SOLOSTORE_KV.get(kvKey.tenantBySlug(slugParam));
    return tenantId ?? null;
  }

  // 3. Subdomain from X-Dev-Host or Host header
  const rawHost = request.headers.get('x-dev-host')
    ?? request.headers.get('host')
    ?? '';
  const hostname = rawHost.split(':')[0].toLowerCase();
  const parts = hostname.split('.');

  const reserved = ['www', 'app', 'api', 'admin'];
  if (parts.length >= 2 && parts[0] && !reserved.includes(parts[0])) {
    const tenantId = await env.SOLOSTORE_KV.get(kvKey.tenantBySlug(parts[0]));
    return tenantId ?? null;
  }

  return null;
}

/**
 * Validate tenant is active and return meta.
 * Returns null with generic error if not found or not active —
 * don't leak whether a tenant exists.
 */
async function getActiveTenant(
  tenantId: string,
  env: Env
): Promise<TenantMeta | null> {
  const tenant = await env.SOLOSTORE_KV.get<TenantMeta>(
    kvKey.tenant(tenantId),
    'json'
  );

  if (!tenant) return null;
  if (!['ready', 'live'].includes(tenant.status)) return null;

  return tenant;
}

// ─── GET /storefront/products ─────────────────────────────────────────────────

export async function handleStorefrontListProducts(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const showStock = url.searchParams.get('showStock') === 'true';

    // ── Resolve tenant ────────────────────────────────────────────────────
    const tenantId = await resolveTenantId(request, url, env);
    if (!tenantId) {
      return Response.json({ error: 'Store not found' }, { status: 404 });
    }

    const tenant = await getActiveTenant(tenantId, env);
    if (!tenant) {
      return Response.json({ error: 'Store not found' }, { status: 404 });
    }

    // ── List products ─────────────────────────────────────────────────────
    const listed = await env.SOLOSTORE_KV.list({
      prefix: kvKey.productList(tenantId),
    });

    const products = (
      await Promise.all(
        listed.keys.map(({ name }) =>
          env.SOLOSTORE_KV.get<Product>(name, 'json')
        )
      )
    ).filter((p): p is Product => p !== null && p.status === 'active');

    // Sort newest first
    products.sort((a, b) => b.createdAt - a.createdAt);

    const publicProducts = products.map(p => sanitiseProduct(p, showStock));

    return Response.json({
      products: publicProducts,
      total: publicProducts.length,
    });

  } catch (err) {
    console.error('[storefront] listProducts error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ─── GET /storefront/products/:id ─────────────────────────────────────────────

export async function handleStorefrontGetProduct(
  request: Request,
  env: Env,
  productId: string
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const showStock = url.searchParams.get('showStock') === 'true';

    // ── Resolve tenant ────────────────────────────────────────────────────
    const tenantId = await resolveTenantId(request, url, env);
    if (!tenantId) {
      return Response.json({ error: 'Store not found' }, { status: 404 });
    }

    const tenant = await getActiveTenant(tenantId, env);
    if (!tenant) {
      return Response.json({ error: 'Store not found' }, { status: 404 });
    }

    // ── Load product ──────────────────────────────────────────────────────
    const product = await env.SOLOSTORE_KV.get<Product>(
      kvKey.product(tenantId, productId),
      'json'
    );

    // Return 404 for archived products too — don't distinguish
    if (!product || product.status === 'archived') {
      return Response.json({ error: 'Product not found' }, { status: 404 });
    }

    // Filter out archived variants before sanitising
    const activeVariantCount = product.variants.filter(v => v.status === 'active').length;
    if (activeVariantCount === 0) {
      // All variants archived — treat as unavailable
      return Response.json({ error: 'Product not found' }, { status: 404 });
    }

    return Response.json(sanitiseProduct(product, showStock));

  } catch (err) {
    console.error('[storefront] getProduct error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
