/* workers/api/src/handlers/checkout.ts */

/**
 * POST /storefront/checkout
 *
 * Public (no merchant auth). Creates a Stripe Checkout Session for a buyer.
 *
 * Security model:
 * - Tenant is resolved from the request body `tenantId` — validated against KV
 * - Line items (prices) are re-read from KV server-side; client cannot influence prices
 * - Application fee is calculated server-side from KV config; client cannot influence it
 * - Checkout Session ID reverse lookup is written to KV (server-side only, never public)
 * - No buyer PII stored in KV — email comes from Stripe at webhook time
 *
 * Attack surface mitigations:
 * - Price tampering: prices sourced from KV, not from request body
 * - Tenant spoofing: tenantId validated — must exist in KV and be in 'ready' or 'live' status
 * - Fee bypass: application_fee_amount calculated server-side
 * - Inventory oversell: stock checked before session creation; decremented on webhook (v1)
 * - Bogus variant IDs: each variantId validated against KV product before proceeding
 * - Quantity abuse: max 100 per line item, max 20 line items per order
 */

import Stripe from 'stripe';
import { kvKey, generateId } from '@solostore/shared';
import type { Env } from '../types/env';
import type { Product, ProductVariant } from './products';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_LINE_ITEMS = 20;
const MAX_QUANTITY_PER_ITEM = 100;

// ─── Types ────────────────────────────────────────────────────────────────────

interface PlatformFeeConfig {
  percentageBps: number;  // basis points — 100 = 1%
  fixedPence: number;     // fixed pence per transaction — 10 = 10p
}

interface CheckoutLineItemInput {
  productId: string;
  variantId: string;
  quantity: number;
}

interface CheckoutInput {
  tenantId: string;
  lineItems: CheckoutLineItemInput[];
  successUrl: string;
  cancelUrl: string;
}

interface TenantMeta {
  status: string;
  stripeAccountId?: string;
  slug?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

class CheckoutError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function variantLabel(variant: ProductVariant): string {
  const parts = [variant.colour, variant.size].filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : 'Default';
}

async function getPlatformFee(env: Env): Promise<PlatformFeeConfig> {
  const config = await env.SOLOSTORE_KV.get<PlatformFeeConfig>(
    kvKey.platformConfig('platform_fee'),
    'json'
  );
  // Fallback to defaults if not seeded yet
  return config ?? { percentageBps: 100, fixedPence: 10 };
}

/**
 * Calculate the application fee for a given total.
 * Formula: (totalPence * percentageBps / 10000) + fixedPence
 * Rounded up to nearest pence to avoid sub-pence amounts.
 */
function calculateFee(totalPence: number, config: PlatformFeeConfig): number {
  const percentage = Math.ceil((totalPence * config.percentageBps) / 10000);
  return percentage + config.fixedPence;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleStorefrontCheckout(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    // ── Parse and validate request body ──────────────────────────────────────
    let body: CheckoutInput;
    try {
      body = await request.json() as CheckoutInput;
    } catch {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { tenantId, lineItems, successUrl, cancelUrl } = body;

    if (!tenantId || typeof tenantId !== 'string') {
      return Response.json({ error: 'tenantId is required' }, { status: 400 });
    }

    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      return Response.json({ error: 'lineItems must be a non-empty array' }, { status: 400 });
    }

    if (lineItems.length > MAX_LINE_ITEMS) {
      return Response.json(
        { error: `Maximum ${MAX_LINE_ITEMS} line items per order` },
        { status: 400 }
      );
    }

    if (!successUrl || !cancelUrl) {
      return Response.json({ error: 'successUrl and cancelUrl are required' }, { status: 400 });
    }

    // Validate URLs are http/https — prevent javascript: or data: injection
    for (const url of [successUrl, cancelUrl]) {
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return Response.json({ error: 'successUrl and cancelUrl must be http or https' }, { status: 400 });
        }
      } catch {
        return Response.json({ error: 'successUrl and cancelUrl must be valid URLs' }, { status: 400 });
      }
    }

    // ── Validate tenant ───────────────────────────────────────────────────────
    const tenantMeta = await env.SOLOSTORE_KV.get<TenantMeta>(
      kvKey.tenant(tenantId),
      'json'
    );

    if (!tenantMeta) {
      // Return generic 400 — don't confirm whether tenantId exists
      return Response.json({ error: 'Invalid checkout request' }, { status: 400 });
    }

    if (!['ready', 'live'].includes(tenantMeta.status)) {
      return Response.json({ error: 'This store is not currently accepting orders' }, { status: 403 });
    }

    if (!tenantMeta.stripeAccountId) {
      return Response.json({ error: 'This store is not currently accepting orders' }, { status: 403 });
    }

    // ── Validate and resolve line items from KV ───────────────────────────────
    // Prices are NEVER taken from the request — always from KV
    const resolvedItems: Array<{
      input: CheckoutLineItemInput;
      product: Product;
      variant: ProductVariant;
    }> = [];

    for (let i = 0; i < lineItems.length; i++) {
      const item = lineItems[i];

      if (!item.productId || typeof item.productId !== 'string') {
        return Response.json({ error: `lineItems[${i}].productId is required` }, { status: 400 });
      }
      if (!item.variantId || typeof item.variantId !== 'string') {
        return Response.json({ error: `lineItems[${i}].variantId is required` }, { status: 400 });
      }
      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        return Response.json({ error: `lineItems[${i}].quantity must be a positive integer` }, { status: 400 });
      }
      if (item.quantity > MAX_QUANTITY_PER_ITEM) {
        return Response.json(
          { error: `lineItems[${i}].quantity cannot exceed ${MAX_QUANTITY_PER_ITEM}` },
          { status: 400 }
        );
      }

      // Load product from KV — scoped to this tenant
      const product = await env.SOLOSTORE_KV.get<Product>(
        kvKey.product(tenantId, item.productId),
        'json'
      );

      if (!product || product.status === 'archived') {
        return Response.json(
          { error: `Product not found or unavailable` },
          { status: 400 }
        );
      }

      const variant = product.variants.find(v => v.id === item.variantId);

      if (!variant || variant.status === 'archived') {
        return Response.json(
          { error: `Variant not found or unavailable` },
          { status: 400 }
        );
      }

      // Stock check — soft (not locked; decrement happens on webhook)
      if (variant.stock < item.quantity) {
        return Response.json(
          {
            error: `Insufficient stock for "${product.name}${variant.colour || variant.size ? ` (${variantLabel(variant)})` : ''}"`,
            available: variant.stock,
          },
          { status: 409 }
        );
      }

      resolvedItems.push({ input: item, product, variant });
    }

    // ── Calculate totals and fee server-side ──────────────────────────────────
    const totalPence = resolvedItems.reduce(
      (sum, { input, variant }) => sum + variant.pricePence * input.quantity,
      0
    );

    const feeConfig = await getPlatformFee(env);
    const applicationFeePence = calculateFee(totalPence, feeConfig);

    // ── Create Stripe Checkout Session ────────────────────────────────────────
    const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: '2026-06-24.dahlia',
    });

    const orderId = generateId('ord');
    const now = Date.now();

    // Determine if any item is physical (needs shipping)
    const hasPhysical = resolvedItems.some(({ product }) => product.type === 'physical');

    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: resolvedItems.map(({ input, product, variant }) => ({
          price: variant.stripePriceId,
          quantity: input.quantity,
          // Price is validated by Stripe against the actual price object —
          // client cannot override unit_amount
        })),
        ...(hasPhysical
          ? { shipping_address_collection: { allowed_countries: ['GB'] } }
          : {}),
        payment_intent_data: {
          application_fee_amount: applicationFeePence,
          metadata: {
            solostore_tenant_id: tenantId,
            solostore_order_id: orderId,
          },
        },
        metadata: {
          solostore_tenant_id: tenantId,
          solostore_order_id: orderId,
        },
        success_url: successUrl,
        cancel_url: cancelUrl,
        // Collect email for order confirmation
        customer_creation: 'always',
      },
      {
        // Create session on the merchant's Connect account
        stripeAccount: tenantMeta.stripeAccountId,
      }
    );

    // ── Write reverse lookup to KV ────────────────────────────────────────────
    // Server-side only. Webhook uses this to find tenantId + orderId from
    // the Stripe session ID. Never exposed via any public route.
    // TTL: 24 hours — sessions expire; we don't need this forever.
    await env.SOLOSTORE_KV.put(
      kvKey.stripeSession(session.id),
      JSON.stringify({ tenantId, orderId }),
      { expirationTtl: 86400 }
    );

    // ── Write pending order to KV ─────────────────────────────────────────────
    // Status is 'pending' until webhook confirms payment.
    // buyerEmail is not available yet — set on webhook.
    const pendingOrder = {
      id: orderId,
      tenantId,
      stripeSessionId: session.id,
      stripePaymentIntentId: undefined,
      buyerEmail: '',           // populated by webhook
      lineItems: resolvedItems.map(({ input, product, variant }) => ({
        variantId: variant.id,
        productId: product.id,
        productName: product.name,
        variantLabel: variantLabel(variant),
        stripePriceId: variant.stripePriceId,
        quantity: input.quantity,
        unitPricePence: variant.pricePence,
        subtotalPence: variant.pricePence * input.quantity,
      })),
      totalPence,
      currency: 'gbp' as const,
      status: 'pending' as const,
      shippingAddress: undefined,
      createdAt: now,
      updatedAt: now,
    };

    await env.SOLOSTORE_KV.put(
      kvKey.order(tenantId, orderId),
      JSON.stringify(pendingOrder)
    );

    // Return only the Checkout Session URL — no internal IDs exposed
    return Response.json(
      { url: session.url },
      { status: 201 }
    );

  } catch (err) {
    console.error('[checkout] Error:', err);
    return Response.json({ error: 'Failed to create checkout session' }, { status: 500 });
  }
}