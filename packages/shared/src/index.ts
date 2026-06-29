/* packages/shared/src/index.ts */

// ─── Tenant ──────────────────────────────────────────────────────────────────

export type TenantStatus =
  | 'pending_payment'
  | 'pending_verification'
  | 'pending_onboarding'
  | 'pending_connect'
  | 'pending_products'
  | 'ready'
  | 'live';

export interface TenantMeta {
  id: string;                  // e.g. "tenant_abc123"
  slug?: string;               // set during onboarding
  customDomain?: string;       // optional, set later
  stripeCustomerId: string;    // platform subscription identity
  stripeAccountId?: string;    // Connect Express — set after onboarding
  status: TenantStatus;
  createdAt: number;           // Unix ms
}

// ─── Session ─────────────────────────────────────────────────────────────────
// Stored in KV under session:{sessionId}
// tenantId is all we need — everything else comes from Stripe

export interface SessionData {
  tenantId: string;
  createdAt: number;           // Unix ms
}

// ─── Order ───────────────────────────────────────────────────────────────────

export type OrderStatus = 'pending' | 'paid' | 'fulfilled' | 'refunded' | 'cancelled';

export interface OrderLineItem {
  variantId: string;
  productId: string;
  productName: string;
  variantLabel: string;       // e.g. "Red / Large", or product name if no colour/size
  stripePriceId: string;
  quantity: number;
  unitPricePence: number;
  subtotalPence: number;
}

export interface ShippingAddress {
  line1: string;
  line2?: string;
  city: string;
  postcode: string;
  country: string;
}

export interface Order {
  id: string;
  tenantId: string;
  stripeSessionId: string;            // Checkout Session ID — primary Stripe reference
  stripePaymentIntentId?: string;     // set when paid (from webhook)
  buyerEmail: string;                 // sourced from Stripe session — not indexed
  lineItems: OrderLineItem[];
  totalPence: number;
  currency: 'gbp';
  status: OrderStatus;
  shippingAddress?: ShippingAddress;  // physical products only
  createdAt: number;
  updatedAt: number;
}

// ─── KV Key Helpers ──────────────────────────────────────────────────────────
//
// All KV keys are prefixed by tenantId to enforce isolation.
// Pattern: tenant:{tenantId}:{resource}:{id}
//
// Global (cross-tenant) keys use prefix: global:{resource}:{id}
export const kvKey = {
  // Tenant record — source of truth for status + Stripe IDs
  tenant: (tenantId: string) =>
    `tenant:${tenantId}:meta`,

  // Global lookups — slug/domain → tenantId
  tenantBySlug: (slug: string) =>
    `global:tenant_slug:${slug}`,

  tenantByDomain: (domain: string) =>
    `global:tenant_domain:${domain}`,

  // Auth — magic links and sessions
  magicToken: (token: string) =>
    `magic:${token}`,

  session: (sessionId: string) =>
    `session:${sessionId}`,

  // Deferred actions — post-payment magic link queue
  deferred: (tenantId: string) =>
    `deferred:${tenantId}`,

  // Commerce — products
  product: (tenantId: string, productId: string) =>
    `tenant:${tenantId}:product:${productId}`,

  productList: (tenantId: string) =>
    `tenant:${tenantId}:product:`,

  // Commerce — orders
  order: (tenantId: string, orderId: string) =>
    `tenant:${tenantId}:order:${orderId}`,

  orderList: (tenantId: string) =>
    `tenant:${tenantId}:order:`,

  // Reverse lookup: Stripe Checkout Session ID → { tenantId, orderId }
  // Written at checkout creation, read by webhook to find the right order.
  // Server-side only — never exposed via any public route.
  stripeSession: (stripeSessionId: string) =>
    `global:stripe_session:${stripeSessionId}`,

  // Platform config — product limit, fee config, etc.
  platformConfig: (key: string) =>
    `global:config:${key}`,

  // Reverse lookup — Connect account ID → tenantId
  connectAccountTenant: (stripeAccountId: string) =>
    `global:connect_account:${stripeAccountId}`,
} as const;


// ─── HTTP Helpers ─────────────────────────────────────────────────────────────

export function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

export function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

// ─── Timing-Safe Comparison ───────────────────────────────────────────────────
//
// Used for webhook signature verification. Prevents timing attacks.

export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  const aKey = await crypto.subtle.importKey(
    'raw', aBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const bKey = await crypto.subtle.importKey(
    'raw', bBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const [aSig, bSig] = await Promise.all([
    crypto.subtle.sign('HMAC', aKey, aBytes),
    crypto.subtle.sign('HMAC', bKey, bBytes),
  ]);
  const aArr = new Uint8Array(aSig);
  const bArr = new Uint8Array(bSig);
  let result = 0;
  for (let i = 0; i < aArr.length; i++) result |= aArr[i] ^ bArr[i];
  return result === 0;
}

// ─── Cookie Helpers ───────────────────────────────────────────────────────────
//
// Uses __Host- prefix: forces Secure, no Domain, Path=/ — strongest cookie security.

export const SESSION_COOKIE = '__Host-ss-session';

export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

export function setSessionCookie(sessionId: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// ─── ID Generation ────────────────────────────────────────────────────────────

export function generateId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
}