import { timingSafeEqual, kvKey, Order, errorResponse, jsonResponse } from '@solostore/shared';

export interface Env {
  KV: KVNamespace;
  STRIPE_WEBHOOK_SECRET: string;
  ENVIRONMENT: string;
}

// ─── Stripe webhook signature verification ────────────────────────────────────
//
// Stripe signs payloads with HMAC-SHA256.
// We verify using our timing-safe comparison to prevent timing attacks.
// Ref: https://stripe.com/docs/webhooks/signatures

async function verifyStripeSignature(
  payload: string,
  sigHeader: string,
  secret: string
): Promise<boolean> {
  const parts = sigHeader.split(',').reduce<Record<string, string>>((acc, part) => {
    const [k, v] = part.split('=');
    if (k && v) acc[k] = v;
    return acc;
  }, {});

  const timestamp = parts['t'];
  const signature = parts['v1'];

  if (!timestamp || !signature) return false;

  // Reject if timestamp is >5 minutes old (replay attack prevention)
  const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
  if (age > 300) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return timingSafeEqual(expected, signature);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') {
      return errorResponse('Method not allowed', 405);
    }

    const sigHeader = request.headers.get('stripe-signature');
    if (!sigHeader) return errorResponse('Missing signature', 400);

    const payload = await request.text();
    const valid = await verifyStripeSignature(payload, sigHeader, env.STRIPE_WEBHOOK_SECRET);
    if (!valid) return errorResponse('Invalid signature', 401);

    let event: { type: string; data: { object: Record<string, unknown> } };
    try {
      event = JSON.parse(payload);
    } catch {
      return errorResponse('Invalid JSON', 400);
    }

    // ── Event dispatch ──
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentSucceeded(event.data.object, env);
        break;

      case 'payment_intent.payment_failed':
        await handlePaymentFailed(event.data.object, env);
        break;

      case 'account.updated':
        // Stripe Connect Express account updates
        await handleAccountUpdated(event.data.object, env);
        break;

      default:
        // Unhandled event types are acknowledged but not processed
        break;
    }

    return jsonResponse({ received: true });
  },
};

// ─── Event handlers (stubs — Phase 5 Stripe Connect implementation) ───────────

async function handlePaymentSucceeded(
  paymentIntent: Record<string, unknown>,
  env: Env
): Promise<void> {
  const tenantId = (paymentIntent['metadata'] as Record<string, string>)?.['tenantId'];
  const orderId = (paymentIntent['metadata'] as Record<string, string>)?.['orderId'];
  if (!tenantId || !orderId) return;

  const order = await env.KV.get(kvKey.order(tenantId, orderId), 'json') as Order | null;
  if (!order) return;

  const updated: Order = { ...order, status: 'paid', updatedAt: Date.now() };
  await env.KV.put(kvKey.order(tenantId, orderId), JSON.stringify(updated));
}

async function handlePaymentFailed(
  paymentIntent: Record<string, unknown>,
  env: Env
): Promise<void> {
  const tenantId = (paymentIntent['metadata'] as Record<string, string>)?.['tenantId'];
  const orderId = (paymentIntent['metadata'] as Record<string, string>)?.['orderId'];
  if (!tenantId || !orderId) return;

  const order = await env.KV.get(kvKey.order(tenantId, orderId), 'json') as Order | null;
  if (!order) return;

  const updated: Order = { ...order, status: 'cancelled', updatedAt: Date.now() };
  await env.KV.put(kvKey.order(tenantId, orderId), JSON.stringify(updated));
}

async function handleAccountUpdated(
  account: Record<string, unknown>,
  env: Env
): Promise<void> {
  // Phase 5: update tenant's Stripe account status in KV
  // account.id → look up tenant → update stripeAccountId / charges_enabled flag
}