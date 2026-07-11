/**
 * POST /register
 *
 * Accepts { email, slug } — validates both, checks slug availability,
 * creates a Stripe Customer, then creates a Checkout Session for
 * the £180/year platform subscription.
 *
 * Slug availability:
 *   - Checked at registration time (best-effort, not a hard lock)
 *   - If taken, returns 409 with up to 3 alternative suggestions
 *   - A narrow race window exists between check and webhook write —
 *     webhook re-checks and handles the collision (see handlePlatformCheckoutCompleted)
 *   - Messaging surfaces this reality to the user before payment
 *
 * NO KV WRITES happen here. Payment must complete first.
 * The webhook (checkout.session.completed) materialises the tenant in KV.
 */

import { generateId, isValidSlug } from "@solostore/shared";
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

function validateEmail(email: string): string | null {
  if (!email || typeof email !== "string") return "Email is required";
  const trimmed = email.trim().toLowerCase();
  if (!EMAIL_RE.test(trimmed)) return "Invalid email address";
  if (trimmed.length > 254) return "Email address too long";
  return null;
}

// ---------------------------------------------------------------------------
// Slug suggestion helpers
// ---------------------------------------------------------------------------

/**
 * Generate up to 3 alternative slug suggestions when the requested one is taken.
 * Tries: suffixes (-shop, -store, -hq), then numeric increments (2, 3, 4).
 * Only returns suggestions that pass full slug validation.
 */
async function generateAlternatives(
  slug: string,
  env: Env
): Promise<string[]> {
  const candidates = [
    `${slug}-shop`,
    `${slug}-store`,
    `${slug}-hq`,
    `${slug}2`,
    `${slug}3`,
    `${slug}4`,
  ];

  const available: string[] = [];

  for (const candidate of candidates) {
    if (!isValidSlug(candidate)) continue;
    const existing = await env.SOLOSTORE_KV.get(`global:tenant_slug:${candidate}`);
    if (!existing) {
      available.push(candidate);
      if (available.length === 3) break;
    }
  }

  return available;
}

// ---------------------------------------------------------------------------
// Stripe helpers
// ---------------------------------------------------------------------------

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

async function createCheckoutSession(
  customerId: string,
  tenantId: string,
  slug: string,
  env: Env
): Promise<StripeCheckoutSession> {
  // Platform domain — no hardcoded external domains
  const platformBase =
    env.ENVIRONMENT === "production"
      ? "https://headorn.com"
      : "http://localhost:8789";

  const body = new URLSearchParams({
    customer: customerId,
    mode: "subscription",
    client_reference_id: tenantId,

    "line_items[0][price_data][currency]": "gbp",
    "line_items[0][price_data][product_data][name]": "SoloStore Platform",
    "line_items[0][price_data][product_data][description]":
      "Annual platform subscription — £180/year",
    "line_items[0][price_data][recurring][interval]": "year",
    "line_items[0][price_data][unit_amount]": "18000",
    "line_items[0][quantity]": "1",

    // After payment: verify endpoint mints session, redirects to headorn.com/onboarding
    success_url: `${platformBase}/pending`,  // static "check your email" page — real magic link sent by cron after webhook fires
    cancel_url: `${platformBase}/?cancelled=true`,

    "metadata[tenantId]": tenantId,
    "metadata[slug]": slug,

    allow_promotion_codes: "true",
  });

  return stripeRequest<StripeCheckoutSession>("/checkout/sessions", {
    method: "POST",
    body,
    apiKey: env.STRIPE_SECRET_KEY,
  });
}

// ---------------------------------------------------------------------------
// GET /register/check-slug?slug=xxx
// Public availability check for live feedback in the signup form
// ---------------------------------------------------------------------------

export async function handleCheckSlug(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const slug = (url.searchParams.get("slug") ?? "").trim().toLowerCase();

  if (!slug) {
    return Response.json({ available: false, error: "slug is required" }, { status: 400 });
  }

  if (!isValidSlug(slug)) {
    return Response.json({
      available: false,
      error: "Store names must be 3–63 characters, lowercase letters, numbers, and hyphens only.",
    });
  }

  const existing = await env.SOLOSTORE_KV.get(`global:tenant_slug:${slug}`);

  if (existing) {
    const alternatives = await generateAlternatives(slug, env);
    return Response.json({
      available: false,
      alternatives,
    });
  }

  return Response.json({ available: true });
}

// ---------------------------------------------------------------------------
// POST /register
// ---------------------------------------------------------------------------

export async function handleRegister(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: RegisterBody;
  try {
    body = (await request.json()) as RegisterBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const slug = (body.slug ?? "").trim().toLowerCase();

  // Validate email
  const emailErr = validateEmail(email);
  if (emailErr) {
    return Response.json({ error: emailErr }, { status: 400 });
  }

  // Validate slug format
  if (!isValidSlug(slug)) {
    return Response.json({
      error: "Store names must be 3–63 characters, lowercase letters, numbers, and hyphens only. Cannot start or end with a hyphen.",
    }, { status: 400 });
  }

  // Slug availability check (best-effort — not a hard lock)
  const existingTenantId = await env.SOLOSTORE_KV.get(`global:tenant_slug:${slug}`);
  if (existingTenantId) {
    const alternatives = await generateAlternatives(slug, env);
    return Response.json(
      {
        error: "That store name is already taken.",
        alternatives,
        // Tell the client the name wasn't available so it can offer a change step
        slugTaken: true,
      },
      { status: 409 }
    );
  }

  // Stripe customer resolution
  let tenantId: string;
  let customerId: string;

  try {
    const existingCustomer = await findCustomerByEmail(email, env.STRIPE_SECRET_KEY);

    if (existingCustomer) {
      customerId = existingCustomer.id;

      if (existingCustomer.metadata.tenantId) {
        tenantId = existingCustomer.metadata.tenantId;
      } else {
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
      tenantId = generateId("tenant");
      const newCustomer = await createCustomer(email, tenantId, slug, env.STRIPE_SECRET_KEY);
      customerId = newCustomer.id;
    }
  } catch (err) {
    console.error("[register] Stripe customer error:", err);
    return Response.json(
      { error: "Failed to set up your account. Please try again." },
      { status: 502 }
    );
  }

  // Create checkout session
  let checkoutUrl: string;
  try {
    const session = await createCheckoutSession(customerId, tenantId, slug, env);
    checkoutUrl = session.url;
  } catch (err) {
    console.error("[register] Checkout session error:", err);
    return Response.json(
      { error: "Failed to create checkout. Please try again." },
      { status: 502 }
    );
  }

  return Response.json({
    checkoutUrl,
    tenantId,
    // Surface the race-condition caveat to the client so it can show appropriate messaging
    notice: "Your store name has been checked and appears available. It will be confirmed once your payment is complete.",
  });
}
