/**
 * workers/webhooks/src/index.ts
 *
 * Handles:
 *   1. POST /webhooks/stripe  — Platform Stripe webhook events
 *      - checkout.session.completed (platform): tenant registration post-payment
 *
 *   2. POST /webhooks/stripe/connect — Connect account webhook events
 *      - checkout.session.completed (connect): order creation post-buyer-payment
 *      - charge.refunded: order status update to 'refunded'
 *      - account.updated: Connect onboarding completion
 *
 *   3. Cron trigger (every minute)
 *      - Scans deferred keys, sends first magic link via Resend, deletes key
 *
 * Security:
 *   - All webhooks verified via HMAC-SHA256 before any logic runs
 *   - 5-minute replay window enforced on every webhook
 *   - Platform and Connect events use separate secrets and separate endpoints
 *   - Idempotency guards on all KV writes
 *
 * GDPR-minimal: no PII in KV. Email retrieved from Stripe at send time.
 */

import {
  kvKey,
  generateId,
  type TenantMeta,
  type TenantStatus,
  type Order,
} from "@solostore/shared";

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

export interface Env {
  SOLOSTORE_KV: KVNamespace;
  ENVIRONMENT: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;          // platform webhook secret
  STRIPE_CONNECT_WEBHOOK_SECRET: string;  // Connect account webhook secret
  RESEND_API_KEY: string;
  RESEND_FROM: string;
  API_BASE_URL: string;                   // e.g. https://api.headorn.com
}


// ---------------------------------------------------------------------------
// HTML escaping
// Prevents user-controlled values breaking email HTML
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------------------------------------------------------------------------
// Stripe signature verification
// Web Crypto — no Node.js crypto required.
// ---------------------------------------------------------------------------

async function verifyStripeSignature(
  payload: string,
  sigHeader: string,
  secret: string
): Promise<boolean> {
  const parts = sigHeader.split(",");
  const tPart = parts.find((p) => p.startsWith("t="));
  const v1Parts = parts.filter((p) => p.startsWith("v1="));

  if (!tPart || v1Parts.length === 0) return false;

  const timestamp = tPart.slice(2);
  const signedPayload = `${timestamp}.${payload}`;

  // Reject events older than 5 minutes (replay attack protection)
  const ts = parseInt(timestamp, 10);
  const ageSeconds = Math.floor(Date.now() / 1000) - ts;
  if (ageSeconds > 300) {
    console.warn("[webhook] Rejected: timestamp too old", ageSeconds);
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedPayload)
  );

  const computed = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return v1Parts.some((part) => {
    const provided = part.slice(3);
    if (provided.length !== computed.length) return false;
    let diff = 0;
    for (let i = 0; i < computed.length; i++) {
      diff |= computed.charCodeAt(i) ^ provided.charCodeAt(i);
    }
    return diff === 0;
  });
}

// ---------------------------------------------------------------------------
// Stripe REST helpers
// ---------------------------------------------------------------------------

async function stripeGet<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const json = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) {
    throw new Error(
      (json as { error?: { message: string } }).error?.message ??
        `Stripe error ${res.status}`
    );
  }
  return json;
}

interface StripeCustomer {
  id: string;
  email: string;
  metadata: Record<string, string>;
}

// Platform checkout session (tenant registration)
interface StripePlatformCheckoutSession {
  id: string;
  customer: string;
  client_reference_id: string;
  metadata: Record<string, string>;
  subscription: string | null;
  amount_total: number | null;
  currency: string | null;
  payment_status: string;
  created: number;
}

// Connect checkout session (buyer purchase)
interface StripeConnectCheckoutSession {
  id: string;
  payment_intent: string | null;
  customer_details: {
    email: string | null;
  } | null;
  metadata: Record<string, string>;
  shipping: {
    address: {
      line1: string;
      line2: string | null;
      city: string;
      postal_code: string;
      country: string;
    };
  } | null;
  amount_total: number | null;
}

interface StripeCharge {
  id: string;
  payment_intent: string;
  refunded: boolean;
  metadata: Record<string, string>;
}

interface StripeAccount {
  id: string;
  details_submitted: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  requirements?: {
    currently_due: string[];
    errors: Array<{ code: string; reason: string; requirement: string }>;
  };
}

function generateOrderReference(): string {
  const date = new Date();

  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");

  const random = crypto
    .randomUUID()
    .replace(/-/g, "")
    .slice(0, 5)
    .toUpperCase();

  return `SOLO-${yyyy}${mm}${dd}-${random}`;
}

// ---------------------------------------------------------------------------
// Resend email helper
// ---------------------------------------------------------------------------

async function sendMagicLink(opts: {
  to: string;
  magicUrl: string;
  tenantSlug: string;
  env: Env;
}): Promise<void> {
  const { to, magicUrl, tenantSlug, env } = opts;


  /*
const allowedHosts =
  env.ENVIRONMENT === "development"
    ? [
        "localhost",
      "127.0.0.1",
        "platform.headorn.com",
        "api.headorn.com",
        "api-staging.headorn.com",
      ]
    : [
        "api.headorn.com",
        "api-staging.headorn.com",
      ];

let apiHost: string;

try {
  apiHost = new URL(env.API_BASE_URL).hostname;
} catch {
  throw new Error("Invalid API_BASE_URL format");
}

if (!allowedHosts.includes(apiHost)) {
  throw new Error(`Invalid API_BASE_URL host: ${apiHost}`);
}
*/
  
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: [to],
      subject: "Welcome to SoloStore — sign in to your dashboard",
      html: `
        <!DOCTYPE html>
        <html lang="en">
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;color:#1a1a1a;">
          <h1 style="font-size:24px;font-weight:700;margin-bottom:8px;">Welcome to SoloStore</h1>
          <p style="color:#555;margin-bottom:32px;">
            Your store <strong>${escapeHtml(tenantSlug)}</strong> is ready. Click the button below to
            sign in to your dashboard and complete setup.
          </p>
          <a href="${escapeHtml(magicUrl)}"
             style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;
                    padding:14px 28px;border-radius:8px;font-weight:600;font-size:15px;">
            Sign in to your store →
          </a>
          <p style="margin-top:32px;font-size:13px;color:#888;">
            This link expires in 15 minutes. If you didn't create a SoloStore account,
            you can safely ignore this email.
          </p>
          <p style="font-size:13px;color:#bbb;margin-top:8px;">
            Can't click? Copy this URL:<br>
            <span style="word-break:break-all;">${escapeHtml(magicUrl)}</span>
          </p>
        </body>
        </html>
      `,
      text: `Welcome to SoloStore\n\nYour store "${escapeHtml(tenantSlug)}" is ready.\n\nSign in here: ${escapeHtml(magicUrl)}\n\nThis link expires in 15 minutes.`,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend error ${res.status}: ${body}`);
  }
}


async function sendPaymentConfirmation(opts: {
  to: string;
  slug: string;
  session: StripePlatformCheckoutSession;
  tenantId: string;
  orderRef: string;
  env: Env;
}): Promise<void> {
  const { to, slug, session, tenantId, orderRef, env } = opts;

  const amount = session.amount_total
    ? `£${(session.amount_total / 100).toFixed(2)}`
    : "£180.00";

  const paidDate = session.created
    ? new Date(session.created * 1000).toUTCString()
    : new Date().toUTCString();

  const storeUrl = `${slug}.headorn.com`;

  //const reference = session.id;
  const reference = orderRef;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: [to],
      subject: "Payment confirmed — your SoloStore is ready",
      html: `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width,initial-scale=1">
        </head>

        <body style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;color:#1a1a1a;">

          <h1 style="font-size:24px;font-weight:700;margin-bottom:8px;">
            Payment confirmed ✓
          </h1>

          <p style="color:#555;line-height:1.6;">
            Thanks for signing up for SoloStore. Your store subscription payment
            has been successfully received.
          </p>

          <div style="
            margin:32px 0;
            padding:20px;
            background:#f7f7f5;
            border-radius:10px;
            border:1px solid #e5e5e5;
          ">

            <h2 style="font-size:16px;margin:0 0 16px;">
              Payment details
            </h2>

            <p style="margin:8px 0;font-size:14px;">
              <strong>Store:</strong><br>
              ${escapeHtml(storeUrl)}
            </p>

            <p style="margin:8px 0;font-size:14px;">
              <strong>Plan:</strong><br>
              SoloStore annual subscription
            </p>

            <p style="margin:8px 0;font-size:14px;">
              <strong>Amount paid:</strong><br>
              ${escapeHtml(amount)}
            </p>

            <p style="margin:8px 0;font-size:14px;">
              <strong>Date:</strong><br>
              ${escapeHtml(paidDate)}
            </p>

            <p style="margin:8px 0;font-size:14px;">
              <strong>Payment reference:</strong><br>
              ${escapeHtml(reference)}
            </p>

            <strong>Order reference:</strong><br>
${escapeHtml(orderRef)}

          </div>

          <p style="color:#555;line-height:1.6;">
            We've also sent you a separate email containing your magic sign-in link.
            Use that link to access your dashboard and finish setting up your store.
          </p>

          <p style="margin-top:32px;font-size:13px;color:#888;">
            If you have any questions, reply to this email and we'll help you out.
          </p>

          <p style="font-size:13px;color:#bbb;margin-top:16px;">
            SoloStore
          </p>

        </body>
        </html>
      `,
      text: `
Payment confirmed — your SoloStore is ready

Thanks for signing up.

Store:
${escapeHtml(storeUrl)}

Plan:
SoloStore annual subscription

Amount paid:
${escapeHtml(amount)}

Date:
${escapeHtml(paidDate)}

Payment reference:
${escapeHtml(reference)}
Order reference:
${escapeHtml(orderRef)}

Your magic sign-in link has been sent separately.
      `.trim(),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend payment confirmation error ${res.status}: ${body}`);
  }

  console.log(`[email] Payment confirmation sent to ${to}`);
}

// ---------------------------------------------------------------------------
// Platform: checkout.session.completed
// Tenant registration after platform subscription payment
// ---------------------------------------------------------------------------

async function handlePlatformCheckoutCompleted(
  session: StripePlatformCheckoutSession,
  env: Env
): Promise<void> {
  let tenantId =
    session.metadata.tenantId ?? session.client_reference_id ?? null;

  const slug = session.metadata.slug ?? null;

  const orderRef = generateOrderReference();


  if (!tenantId) {
    const customer = await stripeGet<StripeCustomer>(
      `/customers/${session.customer}`,
      env.STRIPE_SECRET_KEY
    );
    tenantId = customer.metadata.tenantId ?? null;
  }

  if (!tenantId) {
    throw new Error(`[webhook] Cannot resolve tenantId from session ${session.id}`);
  }

  if (!slug) {
    throw new Error(`[webhook] Cannot resolve slug from session ${session.id} (tenantId: ${tenantId})`);
  }

    
  
  // Idempotency guard
  const existing = await env.SOLOSTORE_KV.get(kvKey.tenant(tenantId));
  if (existing) {
  console.log(`[webhook] Tenant exists — checking payment state`);

  const payment = await env.SOLOSTORE_KV.get(`payment:${session.id}`);

  if (payment) {
    return;
  }
}

  await env.SOLOSTORE_KV.put(
  `payment:${session.id}`,
  JSON.stringify({
    orderRef,
    tenantId,
    amount: session.amount_total,
    currency: session.currency,
    createdAt: Date.now(),
  })
);


  // Slug uniqueness guard
  const existingTenantForSlug = await env.SOLOSTORE_KV.get(`global:tenant_slug:${slug}`);
  if (existingTenantForSlug && existingTenantForSlug !== tenantId) {
    throw new Error(`[webhook] Slug "${slug}" already claimed by ${existingTenantForSlug}`);
  }

  const initialStatus: TenantStatus = "pending_verification";

  const tenantMeta: TenantMeta = {
    id: tenantId,
    slug,
    stripeCustomerId: session.customer,
    stripeAccountId: undefined,
    status: initialStatus,
    createdAt: Date.now(),
  };

  /* cron job on hold
  await Promise.all([
    env.SOLOSTORE_KV.put(kvKey.tenant(tenantId), JSON.stringify(tenantMeta)),
    env.SOLOSTORE_KV.put(`global:tenant_slug:${slug}`, tenantId),
    env.SOLOSTORE_KV.put(
      kvKey.deferred(tenantId),
      JSON.stringify({ tenantId, slug, customerId: session.customer }),
      { expirationTtl: 3600 }
    ),
  ]);
  */
  
  await Promise.all([
  env.SOLOSTORE_KV.put(kvKey.tenant(tenantId), JSON.stringify(tenantMeta)),
  env.SOLOSTORE_KV.put(`global:tenant_slug:${slug}`, tenantId),
  ]);
  
  const customer = await stripeGet<StripeCustomer>(
  `/customers/${session.customer}`,
  env.STRIPE_SECRET_KEY
);

if (!customer.email) {
  throw new Error(`Customer ${session.customer} has no email`);
}

const token = generateId("tok");

await env.SOLOSTORE_KV.put(
  kvKey.magicToken(token),
  JSON.stringify({ tenantId }),
  { expirationTtl: 900 }
);

const magicUrl = `${env.API_BASE_URL}/auth/verify?token=${token}`;

  try {
    await sendMagicLink({
      to: customer.email,
      magicUrl,
      tenantSlug: slug,
      env,
    });
  } catch(err) {
  await env.SOLOSTORE_KV.delete(kvKey.magicToken(token));
  throw err;
}
  
  await sendPaymentConfirmation({
  to: customer.email,
  slug,
  session,
  tenantId,
  orderRef,
  env,
});

console.log(`[webhook] Magic link sent immediately to ${customer.email}`);

  console.log(`[webhook] Tenant ${tenantId} (${slug}) created, status=${initialStatus}`);
}

// ---------------------------------------------------------------------------
// Connect: checkout.session.completed
// Buyer purchase on a merchant's store
// ---------------------------------------------------------------------------

async function handleConnectCheckoutCompleted(
  session: StripeConnectCheckoutSession,
  env: Env
): Promise<void> {
  // ── Resolve tenantId and orderId from KV reverse lookup ──────────────────
  // The checkout handler wrote this key when creating the session.
  // This is server-side only — never exposed publicly.
  const lookupRaw = await env.SOLOSTORE_KV.get(
    kvKey.stripeSession(session.id)
  );

  if (!lookupRaw) {
    // Could be a session not created by this platform — ignore
    console.warn(`[webhook] No KV lookup for Connect session ${session.id} — ignoring`);
    return;
  }

  const { tenantId, orderId } = JSON.parse(lookupRaw) as {
    tenantId: string;
    orderId: string;
  };

  // ── Load the pending order ────────────────────────────────────────────────
  const orderRaw = await env.SOLOSTORE_KV.get(kvKey.order(tenantId, orderId));

  if (!orderRaw) {
    throw new Error(`[webhook] Order ${orderId} not found for tenant ${tenantId}`);
  }

  const order = JSON.parse(orderRaw) as Order;

  // Idempotency guard — if already paid, skip
  if (order.status !== 'pending') {
    console.log(`[webhook] Order ${orderId} already in status '${order.status}' — skipping`);
    return;
  }

  // ── Update order with payment details ─────────────────────────────────────
  const buyerEmail = session.customer_details?.email ?? '';

  const shippingAddress = session.shipping?.address
    ? {
        line1: session.shipping.address.line1,
        line2: session.shipping.address.line2 ?? undefined,
        city: session.shipping.address.city,
        postcode: session.shipping.address.postal_code,
        country: session.shipping.address.country,
      }
    : undefined;

  // ── Decrement stock for each line item ────────────────────────────────────
  // Done here (on confirmed payment) not at checkout creation.
  // Race condition acknowledged: two buyers could purchase the last item
  // if both checkout sessions were created before either webhook fires.
  // Acceptable for v1 — merchant is notified via order and handles manually.
  for (const lineItem of order.lineItems) {
    const productRaw = await env.SOLOSTORE_KV.get(
      kvKey.product(tenantId, lineItem.productId)
    );
    if (!productRaw) continue;

    const product = JSON.parse(productRaw);
    const variantIndex = product.variants.findIndex(
      (v: { id: string }) => v.id === lineItem.variantId
    );
    if (variantIndex === -1) continue;

    const currentStock = product.variants[variantIndex].stock as number;
    const newStock = Math.max(0, currentStock - lineItem.quantity);

    product.variants[variantIndex].stock = newStock;
    product.variants[variantIndex].updatedAt = Date.now();
    product.updatedAt = Date.now();

    await env.SOLOSTORE_KV.put(
      kvKey.product(tenantId, lineItem.productId),
      JSON.stringify(product)
    );
  }

  // ── Write paid order ──────────────────────────────────────────────────────
  const updatedOrder: Order = {
    ...order,
    status: 'paid',
    stripePaymentIntentId: session.payment_intent ?? undefined,
    buyerEmail,
    shippingAddress,
    updatedAt: Date.now(),
  };

  await env.SOLOSTORE_KV.put(
    kvKey.order(tenantId, orderId),
    JSON.stringify(updatedOrder)
  );

  // Clean up the reverse lookup — no longer needed
  await env.SOLOSTORE_KV.delete(kvKey.stripeSession(session.id));

  console.log(`[webhook] Order ${orderId} paid for tenant ${tenantId}, buyer: ${buyerEmail}`);
}

// ---------------------------------------------------------------------------
// Connect: charge.refunded
// Updates order status to 'refunded' — no refund logic here, Stripe handles it
// ---------------------------------------------------------------------------

async function handleChargeRefunded(
  charge: StripeCharge,
  env: Env
): Promise<void> {
  const tenantId = charge.metadata.solostore_tenant_id;
  const orderId = charge.metadata.solostore_order_id;

  if (!tenantId || !orderId) {
    console.warn(`[webhook] charge.refunded: missing metadata on charge ${charge.id}`);
    return;
  }

  const orderRaw = await env.SOLOSTORE_KV.get(kvKey.order(tenantId, orderId));
  if (!orderRaw) {
    console.warn(`[webhook] charge.refunded: order ${orderId} not found`);
    return;
  }

  const order = JSON.parse(orderRaw) as Order;

  if (order.status === 'refunded') {
    console.log(`[webhook] Order ${orderId} already refunded — skipping`);
    return;
  }

  const updated: Order = {
    ...order,
    status: 'refunded',
    updatedAt: Date.now(),
  };

  await env.SOLOSTORE_KV.put(
    kvKey.order(tenantId, orderId),
    JSON.stringify(updated)
  );

  console.log(`[webhook] Order ${orderId} marked refunded for tenant ${tenantId}`);
}

// ---------------------------------------------------------------------------
// Connect: account.updated
// Merchant completes Stripe Connect onboarding
// ---------------------------------------------------------------------------

async function handleAccountUpdated(
  account: StripeAccount,
  env: Env
): Promise<void> {
  const tenantId = await env.SOLOSTORE_KV.get(
    kvKey.connectAccountTenant(account.id)
  );

  if (!tenantId) {
    console.warn(`[webhook] account.updated: no tenant for account ${account.id}`);
    return;
  }

  const metaRaw = await env.SOLOSTORE_KV.get(kvKey.tenant(tenantId));
  if (!metaRaw) {
    console.error(`[webhook] account.updated: no meta for tenant ${tenantId}`);
    return;
  }

  const meta = JSON.parse(metaRaw) as TenantMeta;

  const advanceable: TenantStatus[] = ['pending_verification', 'pending_connect'];
  if (!advanceable.includes(meta.status)) {
    return;
  }

  if (
    account.details_submitted &&
    account.charges_enabled &&
    account.payouts_enabled
  ) {
    const updated: TenantMeta = { ...meta, status: 'pending_products' };
    await env.SOLOSTORE_KV.put(kvKey.tenant(tenantId), JSON.stringify(updated));
    console.log(`[webhook] Tenant ${tenantId} advanced to pending_products`);
  } else {
    const due = account.requirements?.currently_due ?? [];
    console.log(
      `[webhook] account.updated: ${tenantId} not yet fully verified. currently_due=${JSON.stringify(due)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Cron: deferred magic link dispatch
// ---------------------------------------------------------------------------

async function handleCron(env: Env): Promise<void> {
  const prefix = "deferred:";
  const list = await env.SOLOSTORE_KV.list({ prefix });

  if (list.keys.length === 0) {
    console.log("[cron] No deferred keys found");
    return;
  }

  console.log(`[cron] Processing ${list.keys.length} deferred tenant(s)`);

  for (const { name: key } of list.keys) {
    try {
      const raw = await env.SOLOSTORE_KV.get(key);
      if (!raw) continue;

      const { tenantId, slug, customerId } = JSON.parse(raw) as {
        tenantId: string;
        slug: string;
        customerId: string;
      };

      // Fetch email from Stripe — never from KV
      const customer = await stripeGet<StripeCustomer>(
        `/customers/${customerId}`,
        env.STRIPE_SECRET_KEY
      );

      if (!customer.email) {
        throw new Error(`Customer ${customerId} has no email address`);
      }

      const token = generateId("tok");
      const TTL_SECONDS = 900; // 15 minutes

      await env.SOLOSTORE_KV.put(
        kvKey.magicToken(token),
        JSON.stringify({ tenantId }),
        { expirationTtl: TTL_SECONDS }
      );

      // Use API_BASE_URL env var — no hardcoding
      const magicUrl = `${env.API_BASE_URL}/auth/verify?token=${token}`;

      await sendMagicLink({ to: customer.email, magicUrl, tenantSlug: slug, env });

      // Delete AFTER successful send so failures leave the key for retry
      await env.SOLOSTORE_KV.delete(key);

      console.log(`[cron] Magic link sent to ${customer.email} for tenant ${tenantId} (${slug})`);
    } catch (err) {
      console.error(`[cron] Failed to process deferred key ${key}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Webhook request handler (shared logic)
// ---------------------------------------------------------------------------

async function handleWebhookRequest(
  request: Request,
  env: Env,
  secret: string,
  isConnect: boolean
): Promise<Response> {
  const sigHeader = request.headers.get("stripe-signature");
  if (!sigHeader) {
    return new Response(
      JSON.stringify({ error: "Missing stripe-signature header" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Raw body must be read before any parsing — required for signature verification
  const payload = await request.text();

  const valid = await verifyStripeSignature(payload, sigHeader, secret);
  if (!valid) {
    console.warn("[webhook] Signature verification failed");
    return new Response(
      JSON.stringify({ error: "Invalid signature" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  let event: { type: string; data: { object: unknown } };
  try {
    event = JSON.parse(payload);
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON payload" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  console.log(`[webhook${isConnect ? ':connect' : ':platform'}] Received: ${event.type}`);

  try {
    if (isConnect) {
      switch (event.type) {
        case "checkout.session.completed":
          await handleConnectCheckoutCompleted(
            event.data.object as StripeConnectCheckoutSession,
            env
          );
          break;
        case "charge.refunded":
          await handleChargeRefunded(
            event.data.object as StripeCharge,
            env
          );
          break;
        case "account.updated":
          await handleAccountUpdated(
            event.data.object as StripeAccount,
            env
          );
          break;
        default:
          console.log(`[webhook:connect] Unhandled event: ${event.type}`);
      }
    } else {
      switch (event.type) {
        case "checkout.session.completed":
          await handlePlatformCheckoutCompleted(
            event.data.object as StripePlatformCheckoutSession,
            env
          );
          break;
        default:
          console.log(`[webhook:platform] Unhandled event: ${event.type}`);
      }
    }
  } catch (err) {
    // Return 500 so Stripe retries
    console.error(`[webhook] Handler error for ${event.type}:`, err);
    return new Response(
      JSON.stringify({ error: "Webhook handler failed" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Platform webhook — subscription payments (tenant registration)
    if (url.pathname === "/webhooks/stripe" && request.method === "POST") {
      return handleWebhookRequest(request, env, env.STRIPE_WEBHOOK_SECRET, false);
    }

    // Connect webhook — buyer payments, refunds, account updates
    if (url.pathname === "/webhooks/stripe/connect" && request.method === "POST") {
      return handleWebhookRequest(request, env, env.STRIPE_CONNECT_WEBHOOK_SECRET, true);
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(handleCron(env));
  },
};
