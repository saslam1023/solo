/**
 * workers/webhooks/src/index.ts
 *
 * Handles:
 *   1. POST /webhooks/stripe  — Stripe webhook events
 *      - checkout.session.completed: verifies signature, writes TenantMeta to KV,
 *        writes deferred:{tenantId} key for cron pickup
 *
 *   2. Cron trigger (every minute, effective ~60s delay via deferred key TTL)
 *      - Scans deferred keys, sends first magic link via Resend, deletes key
 *
 * GDPR-minimal: no PII in KV. Email retrieved from Stripe at send time.
 * Stripe is source of truth for all identity data.
 */

import {
  kvKey,
  generateId,
  type TenantMeta,
  type TenantStatus,
} from "@solostore/shared";

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

export interface Env {
  SOLOSTORE_KV: KVNamespace;
  ENVIRONMENT: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_CONNECT_WEBHOOK_SECRET: string;   // Phase 5
  RESEND_API_KEY: string;
  RESEND_FROM: string;
}

// ---------------------------------------------------------------------------
// Stripe signature verification
// Web Crypto implementation — no Node.js crypto required.
// ---------------------------------------------------------------------------

async function verifyStripeSignature(
  payload: string,
  sigHeader: string,
  secret: string
): Promise<boolean> {
  // sig header format: t=timestamp,v1=hash[,v1=hash...]
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
    // Timing-safe comparison
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

interface StripeCheckoutSession {
  id: string;
  customer: string;
  client_reference_id: string;
  metadata: Record<string, string>;
  subscription: string | null;
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
            Your store <strong>${tenantSlug}</strong> is ready. Click the button below to
            sign in to your dashboard and complete setup.
          </p>
          <a href="${magicUrl}"
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
            <span style="word-break:break-all;">${magicUrl}</span>
          </p>
        </body>
        </html>
      `,
      text: `Welcome to SoloStore\n\nYour store "${tenantSlug}" is ready.\n\nSign in here: ${magicUrl}\n\nThis link expires in 15 minutes.`,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend error ${res.status}: ${body}`);
  }
}

// ---------------------------------------------------------------------------
// checkout.session.completed handler
// ---------------------------------------------------------------------------

async function handleCheckoutCompleted(
  session: StripeCheckoutSession,
  env: Env
): Promise<void> {
  // ── Resolve tenantId ──────────────────────────────────────────────────────
  // Primary: session.metadata.tenantId (set when creating checkout)
  // Fallback: client_reference_id (also set at checkout creation)
  // Final fallback: customer metadata (set at customer creation)
  let tenantId =
    session.metadata.tenantId ?? session.client_reference_id ?? null;

  const slug = session.metadata.slug ?? null;

  if (!tenantId) {
    // Last resort: fetch customer and read from their metadata
    const customer = await stripeGet<StripeCustomer>(
      `/customers/${session.customer}`,
      env.STRIPE_SECRET_KEY
    );
    tenantId = customer.metadata.tenantId ?? null;
  }

  if (!tenantId) {
    throw new Error(
      `[webhook] Cannot resolve tenantId from session ${session.id}`
    );
  }

  if (!slug) {
    throw new Error(
      `[webhook] Cannot resolve slug from session ${session.id} (tenantId: ${tenantId})`
    );
  }

  // ── Idempotency guard ─────────────────────────────────────────────────────
  // If we already wrote this tenant (webhook replayed), skip writes.
  const existing = await env.SOLOSTORE_KV.get(kvKey.tenant(tenantId));
  if (existing) {
    console.log(
      `[webhook] Tenant ${tenantId} already exists — skipping duplicate write`
    );
    return;
  }

  // ── Slug uniqueness guard ─────────────────────────────────────────────────
  const existingTenantForSlug = await env.SOLOSTORE_KV.get(
    `global:tenant_slug:${slug}`
  );
  if (existingTenantForSlug && existingTenantForSlug !== tenantId) {
    // Slug collision — shouldn't happen if /register checked, but be safe.
    throw new Error(
      `[webhook] Slug "${slug}" already claimed by ${existingTenantForSlug}`
    );
  }

  // ── Build TenantMeta ──────────────────────────────────────────────────────
  const initialStatus: TenantStatus = "pending_verification";

  const tenantMeta: TenantMeta = {
    id: tenantId,
    slug,
    stripeCustomerId: session.customer,
    stripeAccountId: undefined, // set later when merchant completes Connect onboarding
    status: initialStatus,
    createdAt: Date.now(),
  };

  // ── Atomic KV writes ──────────────────────────────────────────────────────
  // Write tenant meta, slug lookup index, and deferred key in parallel.
  // All three must succeed. KV put() does not offer multi-key transactions,
  // so we write in a predictable order and rely on idempotency guard above
  // to handle partial failures on retry.

  await Promise.all([
    // Primary tenant record
    env.SOLOSTORE_KV.put(kvKey.tenant(tenantId), JSON.stringify(tenantMeta)),

    // Slug → tenantId lookup index
    env.SOLOSTORE_KV.put(`global:tenant_slug:${slug}`, tenantId),

    // Deferred key: cron reads this to know who needs a first magic link.
    // TTL: 3600s — if cron fails to pick it up within an hour, it expires
    // and we don't send a stale link. Operator can re-trigger manually.
    env.SOLOSTORE_KV.put(
      kvKey.deferred(tenantId),
      JSON.stringify({ tenantId, slug, customerId: session.customer }),
      { expirationTtl: 3600 }
    ),
  ]);

  console.log(
    `[webhook] Tenant ${tenantId} (${slug}) created, status=${initialStatus}`
  );
}

// ---------------------------------------------------------------------------
// Cron: deferred magic link dispatch
// ---------------------------------------------------------------------------

/**
 * Fires on cron schedule (see wrangler.toml: "* * * * *" = every minute).
 *
 * The deferred key was written by the webhook handler. We use the cron rather
 * than sending immediately in the webhook response to:
 *   1. Decouple email delivery latency from Stripe's 30s webhook timeout.
 *   2. Allow a ~60s settling delay (one cron tick) after payment confirmation
 *      before bothering the user with a sign-in link.
 *   3. Give operators visibility into pending sends via KV if something breaks.
 *
 * KV list() returns up to 1000 keys per call. For a high-volume system this
 * would need cursor pagination, but is sufficient for the current phase.
 */

// ---------------------------------------------------------------------------
// account.updated handler (Phase 5)
// ---------------------------------------------------------------------------

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

async function handleAccountUpdated(
  account: StripeAccount,
  env: Env
): Promise<void> {
  // Reverse-lookup: Connect account ID → tenantId
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
    // Already past this stage — idempotent
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
    console.log(`[webhook] account.updated: ${tenantId} not yet fully verified. currently_due=${JSON.stringify(due)}`);
  }
}

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
      if (!raw) {
        // Already consumed or expired
        continue;
      }

      const { tenantId, slug, customerId } = JSON.parse(raw) as {
        tenantId: string;
        slug: string;
        customerId: string;
      };

      // ── Fetch email from Stripe (never from KV) ───────────────────────────
      const customer = await stripeGet<StripeCustomer>(
        `/customers/${customerId}`,
        env.STRIPE_SECRET_KEY
      );

      if (!customer.email) {
        throw new Error(`Customer ${customerId} has no email address`);
      }

      // ── Generate magic token ──────────────────────────────────────────────
      const token = generateId("tok");
      const TTL_SECONDS = 900; // 15 minutes

      await env.SOLOSTORE_KV.put(
        kvKey.magicToken(token),
        JSON.stringify({ tenantId }),
        { expirationTtl: TTL_SECONDS }
      );

      // ── Build magic URL ───────────────────────────────────────────────────
      const baseUrl =
        env.ENVIRONMENT === "production"
          ? `https://${slug}.solostore.io`
          : `http://localhost:8787`;

      const magicUrl = `${baseUrl}/auth/verify?token=${token}`;

      // ── Send email ────────────────────────────────────────────────────────
      await sendMagicLink({
        to: customer.email,
        magicUrl,
        tenantSlug: slug,
        env,
      });

      // ── Delete deferred key ───────────────────────────────────────────────
      // Delete AFTER successful send so a failed send leaves the key in place
      // for the next cron tick to retry (up to TTL expiry).
      await env.SOLOSTORE_KV.delete(key);

      console.log(
        `[cron] Magic link sent to ${customer.email} for tenant ${tenantId} (${slug})`
      );
    } catch (err) {
      // Log and continue — don't let one failure block the rest of the batch.
      console.error(`[cron] Failed to process deferred key ${key}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── Health check ──────────────────────────────────────────────────────
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── Stripe webhook endpoint ───────────────────────────────────────────
    if (url.pathname === "/webhooks/stripe" && request.method === "POST") {
      const sigHeader = request.headers.get("stripe-signature");
      if (!sigHeader) {
        return new Response(
          JSON.stringify({ error: "Missing stripe-signature header" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      // Read raw body as text — must not be parsed before signature verification
      const payload = await request.text();

      const valid = await verifyStripeSignature(
        payload,
        sigHeader,
        env.STRIPE_WEBHOOK_SECRET
      );

      if (!valid) {
        console.warn("[webhook] Signature verification failed");
        return new Response(
          JSON.stringify({ error: "Invalid signature" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }

      // Parse event after verification
      let event: { type: string; data: { object: unknown } };
      try {
        event = JSON.parse(payload);
      } catch {
        return new Response(
          JSON.stringify({ error: "Invalid JSON payload" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      console.log(`[webhook] Received event: ${event.type}`);

      try {
        switch (event.type) {
          case "checkout.session.completed":
            await handleCheckoutCompleted(
              event.data.object as StripeCheckoutSession,
              env
            );
            break;
            case 'account.updated':
            await handleAccountUpdated(
              event.data.object as StripeAccount,
              env
            );
            break;

          // Future events wired here:
          // case "customer.subscription.deleted": ...
          // case "invoice.payment_failed": ...
          default:
            console.log(`[webhook] Unhandled event type: ${event.type}`);
        }
      } catch (err) {
        // Return 500 so Stripe retries — do not swallow errors silently.
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
