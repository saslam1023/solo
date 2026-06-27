/**
 * POST /register
 *
 * Accepts { email, slug } — validates both, creates a Stripe Customer with
 * metadata.tenantId set at creation time, then creates a Checkout Session for
 * the £180/year platform subscription.
 *
 * NO KV WRITES happen here. Payment must complete first. The webhook handler
 * (checkout.session.completed) is responsible for materialising the tenant in KV.
 *
 * Drop into: workers/api/src/handlers/register.ts
 */

import { generateId } from "@solostore/shared";
import type { Env } from "../types/env";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RegisterBody {
  email: string;
  slug: string;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Slugs: 3–32 lowercase alphanumeric + hyphens, no leading/trailing hyphen,
 * no consecutive hyphens. Reserved words are blocked to protect platform routes.
 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SLUG_MIN = 3;
const SLUG_MAX = 32;

const RESERVED_SLUGS = new Set([
  "www",
  "app",
  "api",
  "admin",
  "dashboard",
  "auth",
  "login",
  "register",
  "checkout",
  "billing",
  "webhook",
  "webhooks",
  "static",
  "assets",
  "health",
  "status",
  "support",
  "help",
  "docs",
  "mail",
  "smtp",
  "ftp",
  "cdn",
]);

function validateEmail(email: string): string | null {
  if (!email || typeof email !== "string") return "Email is required";
  const trimmed = email.trim().toLowerCase();
  if (!EMAIL_RE.test(trimmed)) return "Invalid email address";
  if (trimmed.length > 254) return "Email address too long";
  return null;
}

function validateSlug(slug: string): string | null {
  if (!slug || typeof slug !== "string") return "Store slug is required";
  const lower = slug.toLowerCase();
  if (lower.length < SLUG_MIN)
    return `Slug must be at least ${SLUG_MIN} characters`;
  if (lower.length > SLUG_MAX)
    return `Slug must be at most ${SLUG_MAX} characters`;
  if (!SLUG_RE.test(lower))
    return "Slug may only contain lowercase letters, numbers, and hyphens, and may not start or end with a hyphen";
  if (/--/.test(lower)) return "Slug may not contain consecutive hyphens";
  if (RESERVED_SLUGS.has(lower)) return "That slug is reserved";
  return null;
}

// ---------------------------------------------------------------------------
// Stripe helpers
// ---------------------------------------------------------------------------

/**
 * Minimal typed wrappers around the Stripe REST API.
 * We call Stripe directly (fetch) rather than using the npm SDK because
 * Cloudflare Workers don't support all Node.js APIs the SDK depends on.
 */

async function stripeRequest<T>(
  path: string,
  options: {
    method?: "GET" | "POST";
    body?: URLSearchParams;
    apiKey: string;
  }
): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: options.body?.toString(),
  });

  const json = (await res.json()) as T & { error?: { message: string } };

  if (!res.ok) {
    const errMsg =
      (json as { error?: { message: string } }).error?.message ??
      `Stripe error ${res.status}`;
    throw new Error(errMsg);
  }

  return json;
}

interface StripeCustomer {
  id: string;
  email: string;
  metadata: Record<string, string>;
}

interface StripeCustomerList {
  data: StripeCustomer[];
}

interface StripeCheckoutSession {
  id: string;
  url: string;
}

/**
 * Look up an existing Stripe customer by email.
 * Returns the first match, or null if none exists.
 */
async function findCustomerByEmail(
  email: string,
  apiKey: string
): Promise<StripeCustomer | null> {
  const params = new URLSearchParams({ email, limit: "1" });
  const list = await stripeRequest<StripeCustomerList>(
    `/customers?${params.toString()}`,
    { method: "GET", apiKey }
  );
  return list.data[0] ?? null;
}

/**
 * Create a new Stripe customer.
 * tenantId is stored in metadata at creation time so that all subsequent
 * webhook events carry the identifier without any KV lookup.
 */
async function createCustomer(
  email: string,
  tenantId: string,
  slug: string,
  apiKey: string
): Promise<StripeCustomer> {
  const body = new URLSearchParams({
    email,
    "metadata[tenantId]": tenantId,
    "metadata[slug]": slug,
  });
  return stripeRequest<StripeCustomer>("/customers", {
    method: "POST",
    body,
    apiKey,
  });
}

/**
 * Create a Stripe Checkout Session for the £180/year subscription.
 *
 * price_data is used instead of a pre-created Price ID so that the platform
 * price is defined in code (single source of truth) and requires no Stripe
 * dashboard setup. Switch to a hardcoded price ID once the product is stable.
 *
 * client_reference_id carries tenantId so the webhook can always recover it
 * even if metadata lookup fails (belt-and-suspenders).
 */
async function createCheckoutSession(
  customerId: string,
  tenantId: string,
  slug: string,
  env: Env
): Promise<StripeCheckoutSession> {
  const baseUrl =
    env.ENVIRONMENT === "production"
      ? `https://${slug}.solostore.io`
      : `http://localhost:8100`;

  const body = new URLSearchParams({
    customer: customerId,
    mode: "subscription",
    client_reference_id: tenantId,

    // Line item — £180/year platform subscription
    "line_items[0][price_data][currency]": "gbp",
    "line_items[0][price_data][product_data][name]": "SoloStore Platform",
    "line_items[0][price_data][product_data][description]":
      "Annual platform subscription — £180/year",
    "line_items[0][price_data][recurring][interval]": "year",
    "line_items[0][price_data][unit_amount]": "18000", // 18000 pence = £180
    "line_items[0][quantity]": "1",

    // Redirect URLs
    success_url: `${baseUrl}/auth/verify?session_id={CHECKOUT_SESSION_ID}&post_checkout=true`,
    cancel_url: `${baseUrl}/register?cancelled=true`,

    // Metadata carried through to checkout.session.completed webhook
    "metadata[tenantId]": tenantId,
    "metadata[slug]": slug,

    // Allow promotion codes for future discount campaigns
    allow_promotion_codes: "true",
  });

  return stripeRequest<StripeCheckoutSession>("/checkout/sessions", {
    method: "POST",
    body,
    apiKey: env.STRIPE_SECRET_KEY,
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleRegister(
  request: Request,
  env: Env
): Promise<Response> {
  // ── Method guard ──────────────────────────────────────────────────────────
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: RegisterBody;
  try {
    body = (await request.json()) as RegisterBody;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const slug = (body.slug ?? "").trim().toLowerCase();

  // ── Validate ──────────────────────────────────────────────────────────────
  const emailErr = validateEmail(email);
  if (emailErr) {
    return new Response(JSON.stringify({ error: emailErr }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const slugErr = validateSlug(slug);
  if (slugErr) {
    return new Response(JSON.stringify({ error: slugErr }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── Slug uniqueness check (KV) ────────────────────────────────────────────
  // We check KV even though the tenant isn't written yet, because a completed
  // checkout may have already claimed this slug. This is a best-effort guard;
  // the webhook handler is the authoritative write and must also check.
  const existingTenantId = await env.SOLOSTORE_KV.get(
    `global:tenant_slug:${slug}`
  );
  if (existingTenantId) {
    return new Response(
      JSON.stringify({ error: "That store slug is already taken" }),
      { status: 409, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Stripe customer resolution ────────────────────────────────────────────
  // If the email already has a Stripe customer:
  //   - Re-use it if it already has a tenantId (idempotent re-registration).
  //   - Re-use it without a tenantId (new tenant for existing Stripe contact).
  // This avoids duplicate customers and handles the "user registered then
  // abandoned checkout" scenario gracefully.

  let tenantId: string;
  let customerId: string;

  try {
    const existingCustomer = await findCustomerByEmail(
      email,
      env.STRIPE_SECRET_KEY
    );

    if (existingCustomer) {
      customerId = existingCustomer.id;

      if (existingCustomer.metadata.tenantId) {
        // They already have a tenant — re-use the same tenantId so they can
        // retry checkout without orphaning the previous registration attempt.
        tenantId = existingCustomer.metadata.tenantId;
      } else {
        // Existing Stripe customer but no tenant yet — generate a fresh id
        // and patch the customer metadata.
        tenantId = generateId("tenant");
        const patchBody = new URLSearchParams({
          "metadata[tenantId]": tenantId,
          "metadata[slug]": slug,
        });
        await stripeRequest(`/customers/${customerId}`, {
          method: "POST",
          body: patchBody,
          apiKey: env.STRIPE_SECRET_KEY,
        });
      }
    } else {
      // Brand new registrant — create customer with metadata embedded.
      tenantId = generateId("tenant");
      const newCustomer = await createCustomer(
        email,
        tenantId,
        slug,
        env.STRIPE_SECRET_KEY
      );
      customerId = newCustomer.id;
    }
  } catch (err) {
    console.error("[register] Stripe customer error:", err);
    return new Response(
      JSON.stringify({ error: "Failed to set up your account. Please try again." }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Stripe Checkout Session ───────────────────────────────────────────────
  let checkoutUrl: string;
  try {
    const session = await createCheckoutSession(
      customerId,
      tenantId,
      slug,
      env
    );
    checkoutUrl = session.url;
  } catch (err) {
    console.error("[register] Checkout session error:", err);
    return new Response(
      JSON.stringify({ error: "Failed to create checkout. Please try again." }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Response ──────────────────────────────────────────────────────────────
  // Return the checkout URL. The client redirects to Stripe-hosted checkout.
  // No KV writes. No session. Nothing persisted until webhook confirms payment.
  return new Response(
    JSON.stringify({
      checkoutUrl,
      tenantId, // useful for the client to track state client-side if needed
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}
