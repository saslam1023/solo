/* workers/api/src/handlers/products.ts */

import Stripe from 'stripe';
import { kvKey, generateId } from '@solostore/shared';
import type { Env } from '../types/env';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProductVariant {
  id: string;
  sku?: string;
  colour?: string;
  size?: string;
  weightG?: number;
  stock: number;
  pricePence: number;
  status: 'active' | 'archived';
  stripeProductId: string;
  stripePriceId: string;
  createdAt: number;
  updatedAt: number;
}

export interface Product {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  currency: 'gbp';
  status: 'active' | 'archived';
  type: 'physical' | 'digital';
  materials?: string[];
  tags?: string[];
  imageUrls: string[];
  variants: ProductVariant[];
  createdAt: number;
  updatedAt: number;
}

interface TenantMeta {
  status: string;
  stripeAccountId?: string;
}

interface PlatformConfig {
  limit: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PRODUCT_LIMIT = 50;
const WARN_THRESHOLD = 0.8; // warn at 80%

// ─── Helpers ─────────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  console.error('[products] Unexpected error:', err);
  return Response.json({ error: 'Internal server error' }, { status: 500 });
}

function stripeForAccount(env: Env, stripeAccountId: string): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2026-06-24.dahlia',
    stripeAccount: stripeAccountId,
  });
}

async function requireConnectedTenant(
  env: Env,
  tenantId: string
): Promise<{ stripeAccountId: string }> {
  const meta = await env.SOLOSTORE_KV.get<TenantMeta>(
    kvKey.tenant(tenantId),
    'json'
  );

  if (!meta) throw new ApiError(404, 'Tenant not found');

  const allowed = ['pending_products', 'ready', 'live'];
  if (!allowed.includes(meta.status)) {
    throw new ApiError(
      403,
      `Tenant not eligible to manage products (status: ${meta.status})`
    );
  }

  if (!meta.stripeAccountId) {
    throw new ApiError(400, 'Stripe Connect account not linked');
  }

  return { stripeAccountId: meta.stripeAccountId };
}

async function getProductLimit(env: Env): Promise<number> {
  const config = await env.SOLOSTORE_KV.get<PlatformConfig>(
    kvKey.platformConfig('product_limit'),
    'json'
  );
  return config?.limit ?? DEFAULT_PRODUCT_LIMIT;
}

async function countActiveProducts(env: Env, tenantId: string): Promise<number> {
  const listed = await env.SOLOSTORE_KV.list({ prefix: kvKey.productList(tenantId) });
  const products = await Promise.all(
    listed.keys.map(({ name }) => env.SOLOSTORE_KV.get<Product>(name, 'json'))
  );
  return products.filter(p => p !== null && p.status === 'active').length;
}

async function checkProductLimit(
  env: Env,
  tenantId: string
): Promise<{ blocked: boolean; warning?: string }> {
  const [limit, count] = await Promise.all([
    getProductLimit(env),
    countActiveProducts(env, tenantId),
  ]);

  if (count >= limit) {
    return {
      blocked: true,
      warning: `Product limit reached (${count}/${limit}). Archive a product to add a new one.`,
    };
  }

  if (count >= Math.floor(limit * WARN_THRESHOLD)) {
    return {
      blocked: false,
      warning: `You are approaching your product limit (${count + 1}/${limit}).`,
    };
  }

  return { blocked: false };
}

async function createStripeVariant(
  stripe: Stripe,
  productName: string,
  variant: Pick<ProductVariant, 'colour' | 'size' | 'sku' | 'pricePence'>,
  tenantId: string,
  productId: string,
  variantId: string
): Promise<{ stripeProductId: string; stripePriceId: string }> {
  const variantLabel = [variant.colour, variant.size].filter(Boolean).join(' / ');
  const stripeName = variantLabel ? `${productName} — ${variantLabel}` : productName;

  const stripeProduct = await stripe.products.create({
    name: stripeName,
    metadata: {
      solostore_tenant_id: tenantId,
      solostore_product_id: productId,
      solostore_variant_id: variantId,
      ...(variant.sku ? { sku: variant.sku } : {}),
    },
  });

  const stripePrice = await stripe.prices.create({
    product: stripeProduct.id,
    unit_amount: variant.pricePence,
    currency: 'gbp',
    metadata: {
      solostore_tenant_id: tenantId,
      solostore_product_id: productId,
      solostore_variant_id: variantId,
    },
  });

  return {
    stripeProductId: stripeProduct.id,
    stripePriceId: stripePrice.id,
  };
}

// ─── POST /products ───────────────────────────────────────────────────────────

interface VariantInput {
  sku?: string;
  colour?: string;
  size?: string;
  weightG?: number;
  stock?: number;
  pricePence: number;
}

interface CreateProductInput {
  name?: string;
  description?: string;
  type?: 'physical' | 'digital';
  materials?: string[];
  tags?: string[];
  variants?: VariantInput[];
}

export async function handleCreateProduct(
  request: Request,
  env: Env,
  tenantId: string
): Promise<Response> {
  try {
    const { stripeAccountId } = await requireConnectedTenant(env, tenantId);

    const limitCheck = await checkProductLimit(env, tenantId);
    if (limitCheck.blocked) {
      return Response.json({ error: limitCheck.warning }, { status: 403 });
    }

    const body = await request.json() as CreateProductInput;
    const { name, description, type, materials, tags, variants } = body;

    // Validate top-level fields
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return Response.json({ error: 'name is required' }, { status: 400 });
    }
    if (typeof description !== 'string') {
      return Response.json({ error: 'description is required' }, { status: 400 });
    }
    if (type !== 'physical' && type !== 'digital') {
      return Response.json({ error: 'type must be "physical" or "digital"' }, { status: 400 });
    }
    if (!Array.isArray(variants) || variants.length === 0) {
      return Response.json({ error: 'at least one variant is required' }, { status: 400 });
    }

    // Validate each variant
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      if (!Number.isInteger(v.pricePence) || v.pricePence < 1) {
        return Response.json(
          { error: `variants[${i}].pricePence must be a positive integer (pence)` },
          { status: 400 }
        );
      }
      if (v.stock !== undefined && (!Number.isInteger(v.stock) || v.stock < 0)) {
        return Response.json(
          { error: `variants[${i}].stock must be a non-negative integer` },
          { status: 400 }
        );
      }
      if (type === 'physical' && v.weightG !== undefined) {
        if (!Number.isInteger(v.weightG) || v.weightG < 0) {
          return Response.json(
            { error: `variants[${i}].weightG must be a non-negative integer (grams)` },
            { status: 400 }
          );
        }
      }
    }

    const stripe = stripeForAccount(env, stripeAccountId);
    const productId = generateId('prod');
    const now = Date.now();

    // Create Stripe Product+Price per variant
    const builtVariants: ProductVariant[] = await Promise.all(
      variants.map(async (v) => {
        const variantId = generateId('var');
        const { stripeProductId, stripePriceId } = await createStripeVariant(
          stripe,
          name.trim(),
          v,
          tenantId,
          productId,
          variantId
        );

        return {
          id: variantId,
          sku: v.sku?.trim(),
          colour: v.colour?.trim(),
          size: v.size?.trim(),
          weightG: type === 'physical' ? v.weightG : undefined,
          stock: v.stock ?? 0,
          pricePence: v.pricePence,
          status: 'active' as const,
          stripeProductId,
          stripePriceId,
          createdAt: now,
          updatedAt: now,
        };
      })
    );

    const product: Product = {
      id: productId,
      tenantId,
      name: name.trim(),
      description: description.trim(),
      currency: 'gbp',
      status: 'active',
      type,
      materials: Array.isArray(materials) ? materials.map(m => m.trim()).filter(Boolean) : undefined,
      tags: Array.isArray(tags) ? tags.map(t => t.trim()).filter(Boolean) : undefined,
      imageUrls: [],
      variants: builtVariants,
      createdAt: now,
      updatedAt: now,
    };

    await env.SOLOSTORE_KV.put(
      kvKey.product(tenantId, productId),
      JSON.stringify(product)
    );

    const response: Record<string, unknown> = { ...product };
    if (limitCheck.warning) response.warning = limitCheck.warning;

    return Response.json(response, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── GET /products ────────────────────────────────────────────────────────────

export async function handleListProducts(
  _request: Request,
  env: Env,
  tenantId: string
): Promise<Response> {
  try {
    await requireConnectedTenant(env, tenantId);

    const listed = await env.SOLOSTORE_KV.list({ prefix: kvKey.productList(tenantId) });

    const products = await Promise.all(
      listed.keys.map(({ name }) => env.SOLOSTORE_KV.get<Product>(name, 'json'))
    );

    const active = products.filter((p): p is Product => p !== null && p.status === 'active');

    return Response.json(active);
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── GET /products/:id ────────────────────────────────────────────────────────

export async function handleGetProduct(
  _request: Request,
  env: Env,
  tenantId: string,
  productId: string
): Promise<Response> {
  try {
    await requireConnectedTenant(env, tenantId);

    const product = await env.SOLOSTORE_KV.get<Product>(
      kvKey.product(tenantId, productId),
      'json'
    );

    if (!product) {
      return Response.json({ error: 'Product not found' }, { status: 404 });
    }

    return Response.json(product);
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── PATCH /products/:id ──────────────────────────────────────────────────────

interface UpdateProductInput {
  name?: string;
  description?: string;
  materials?: string[];
  tags?: string[];
}

export async function handleUpdateProduct(
  request: Request,
  env: Env,
  tenantId: string,
  productId: string
): Promise<Response> {
  try {
    await requireConnectedTenant(env, tenantId);

    const product = await env.SOLOSTORE_KV.get<Product>(
      kvKey.product(tenantId, productId),
      'json'
    );

    if (!product) return Response.json({ error: 'Product not found' }, { status: 404 });
    if (product.status === 'archived') {
      return Response.json({ error: 'Cannot update an archived product' }, { status: 400 });
    }

    const body = await request.json() as UpdateProductInput;
    const updated: Product = { ...product, updatedAt: Date.now() };

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        return Response.json({ error: 'name must be a non-empty string' }, { status: 400 });
      }
      updated.name = body.name.trim();
    }

    if (body.description !== undefined) {
      if (typeof body.description !== 'string') {
        return Response.json({ error: 'description must be a string' }, { status: 400 });
      }
      updated.description = body.description.trim();
    }

    if (body.materials !== undefined) {
      if (!Array.isArray(body.materials)) {
        return Response.json({ error: 'materials must be an array' }, { status: 400 });
      }
      updated.materials = body.materials.map(m => m.trim()).filter(Boolean);
    }

    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags)) {
        return Response.json({ error: 'tags must be an array' }, { status: 400 });
      }
      updated.tags = body.tags.map(t => t.trim()).filter(Boolean);
    }

    await env.SOLOSTORE_KV.put(
      kvKey.product(tenantId, productId),
      JSON.stringify(updated)
    );

    return Response.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── PATCH /products/:id/variants/:variantId ──────────────────────────────────

interface UpdateVariantInput {
  sku?: string;
  colour?: string;
  size?: string;
  weightG?: number;
  stock?: number;
  pricePence?: number;
}

export async function handleUpdateVariant(
  request: Request,
  env: Env,
  tenantId: string,
  productId: string,
  variantId: string
): Promise<Response> {
  try {
    const { stripeAccountId } = await requireConnectedTenant(env, tenantId);

    const product = await env.SOLOSTORE_KV.get<Product>(
      kvKey.product(tenantId, productId),
      'json'
    );

    if (!product) return Response.json({ error: 'Product not found' }, { status: 404 });
    if (product.status === 'archived') {
      return Response.json({ error: 'Cannot update a variant on an archived product' }, { status: 400 });
    }

    const variantIndex = product.variants.findIndex(v => v.id === variantId);
    if (variantIndex === -1) {
      return Response.json({ error: 'Variant not found' }, { status: 404 });
    }

    const variant = product.variants[variantIndex];
    if (variant.status === 'archived') {
      return Response.json({ error: 'Cannot update an archived variant' }, { status: 400 });
    }

    const body = await request.json() as UpdateVariantInput;
    const updatedVariant: ProductVariant = { ...variant, updatedAt: Date.now() };

    if (body.sku !== undefined) updatedVariant.sku = body.sku.trim() || undefined;
    if (body.colour !== undefined) updatedVariant.colour = body.colour.trim() || undefined;
    if (body.size !== undefined) updatedVariant.size = body.size.trim() || undefined;

    if (body.stock !== undefined) {
      if (!Number.isInteger(body.stock) || body.stock < 0) {
        return Response.json({ error: 'stock must be a non-negative integer' }, { status: 400 });
      }
      updatedVariant.stock = body.stock;
    }

    if (body.weightG !== undefined) {
      if (!Number.isInteger(body.weightG) || body.weightG < 0) {
        return Response.json({ error: 'weightG must be a non-negative integer' }, { status: 400 });
      }
      updatedVariant.weightG = body.weightG;
    }

    // Price change: archive old Stripe Price, create new one
    if (body.pricePence !== undefined) {
      if (!Number.isInteger(body.pricePence) || body.pricePence < 1) {
        return Response.json({ error: 'pricePence must be a positive integer' }, { status: 400 });
      }

      const stripe = stripeForAccount(env, stripeAccountId);

      await stripe.prices.update(variant.stripePriceId, { active: false });

      const newPrice = await stripe.prices.create({
        product: variant.stripeProductId,
        unit_amount: body.pricePence,
        currency: 'gbp',
        metadata: {
          solostore_tenant_id: tenantId,
          solostore_product_id: productId,
          solostore_variant_id: variantId,
        },
      });

      updatedVariant.stripePriceId = newPrice.id;
      updatedVariant.pricePence = body.pricePence;
    }

    const updatedVariants = [...product.variants];
    updatedVariants[variantIndex] = updatedVariant;

    const updatedProduct: Product = {
      ...product,
      variants: updatedVariants,
      updatedAt: Date.now(),
    };

    await env.SOLOSTORE_KV.put(
      kvKey.product(tenantId, productId),
      JSON.stringify(updatedProduct)
    );

    return Response.json(updatedProduct);
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── DELETE /products/:id ─────────────────────────────────────────────────────

export async function handleArchiveProduct(
  _request: Request,
  env: Env,
  tenantId: string,
  productId: string
): Promise<Response> {
  try {
    const { stripeAccountId } = await requireConnectedTenant(env, tenantId);

    const product = await env.SOLOSTORE_KV.get<Product>(
      kvKey.product(tenantId, productId),
      'json'
    );

    if (!product) return Response.json({ error: 'Product not found' }, { status: 404 });
    if (product.status === 'archived') {
      return Response.json({ error: 'Product is already archived' }, { status: 400 });
    }

    const stripe = stripeForAccount(env, stripeAccountId);

    // Archive all active variants on Stripe
    await Promise.all(
      product.variants
        .filter(v => v.status === 'active')
        .map(async v => {
          await stripe.prices.update(v.stripePriceId, { active: false });
          await stripe.products.update(v.stripeProductId, { active: false });
        })
    );

    const archived: Product = {
      ...product,
      status: 'archived',
      variants: product.variants.map(v => ({
        ...v,
        status: 'archived' as const,
        updatedAt: Date.now(),
      })),
      updatedAt: Date.now(),
    };

    await env.SOLOSTORE_KV.put(
      kvKey.product(tenantId, productId),
      JSON.stringify(archived)
    );

    return Response.json(archived);
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── DELETE /products/:id/variants/:variantId ─────────────────────────────────

export async function handleArchiveVariant(
  _request: Request,
  env: Env,
  tenantId: string,
  productId: string,
  variantId: string
): Promise<Response> {
  try {
    const { stripeAccountId } = await requireConnectedTenant(env, tenantId);

    const product = await env.SOLOSTORE_KV.get<Product>(
      kvKey.product(tenantId, productId),
      'json'
    );

    if (!product) return Response.json({ error: 'Product not found' }, { status: 404 });
    if (product.status === 'archived') {
      return Response.json({ error: 'Product is archived' }, { status: 400 });
    }

    const variantIndex = product.variants.findIndex(v => v.id === variantId);
    if (variantIndex === -1) {
      return Response.json({ error: 'Variant not found' }, { status: 404 });
    }

    const variant = product.variants[variantIndex];
    if (variant.status === 'archived') {
      return Response.json({ error: 'Variant is already archived' }, { status: 400 });
    }

    // Must keep at least one active variant
    const activeCount = product.variants.filter(v => v.status === 'active').length;
    if (activeCount <= 1) {
      return Response.json(
        { error: 'Cannot archive the last active variant. Archive the product instead.' },
        { status: 400 }
      );
    }

    const stripe = stripeForAccount(env, stripeAccountId);
    await stripe.prices.update(variant.stripePriceId, { active: false });
    await stripe.products.update(variant.stripeProductId, { active: false });

    const updatedVariants = [...product.variants];
    updatedVariants[variantIndex] = {
      ...variant,
      status: 'archived',
      updatedAt: Date.now(),
    };

    const updatedProduct: Product = {
      ...product,
      variants: updatedVariants,
      updatedAt: Date.now(),
    };

    await env.SOLOSTORE_KV.put(
      kvKey.product(tenantId, productId),
      JSON.stringify(updatedProduct)
    );

    return Response.json(updatedProduct);
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── POST /products/:id/images ────────────────────────────────────────────────

export async function handleUploadProductImage(
  request: Request,
  env: Env,
  tenantId: string,
  productId: string
): Promise<Response> {
  try {
    await requireConnectedTenant(env, tenantId);

    const product = await env.SOLOSTORE_KV.get<Product>(
      kvKey.product(tenantId, productId),
      'json'
    );

    if (!product) return Response.json({ error: 'Product not found' }, { status: 404 });
    if (product.status === 'archived') {
      return Response.json({ error: 'Cannot upload image to archived product' }, { status: 400 });
    }

    const contentType = request.headers.get('content-type') ?? '';
    const allowed: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
    };

    if (!allowed[contentType]) {
      return Response.json(
        { error: 'Unsupported image type. Allowed: jpeg, png, webp, gif' },
        { status: 415 }
      );
    }

    const body = await request.arrayBuffer();

    if (body.byteLength === 0) {
      return Response.json({ error: 'Empty image body' }, { status: 400 });
    }
    if (body.byteLength > 5 * 1024 * 1024) {
      return Response.json({ error: 'Image too large (max 5MB)' }, { status: 413 });
    }

    const ext = allowed[contentType];
    const filename = `${generateId('img')}.${ext}`;
    const r2Key = `products/${tenantId}/${productId}/${filename}`;

    await env.SOLOSTORE_R2.put(r2Key, body, {
      httpMetadata: { contentType },
    });

    const imageUrl = `${env.R2_PUBLIC_URL}/${r2Key}`;

    const updatedProduct: Product = {
      ...product,
      imageUrls: [...product.imageUrls, imageUrl],
      updatedAt: Date.now(),
    };

    await env.SOLOSTORE_KV.put(
      kvKey.product(tenantId, productId),
      JSON.stringify(updatedProduct)
    );

    return Response.json({ imageUrl, product: updatedProduct }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}