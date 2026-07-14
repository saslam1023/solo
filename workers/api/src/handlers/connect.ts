/* workers/api/src/handlers/connect.ts */

import { kvKey, type TenantMeta } from '@solostore/shared';
import { Env } from '../types/env';
import { getSession, getTenantMeta } from '../lib/auth';
import { parseSessionCookie } from '@solostore/shared';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Connect onboarding runs while a tenant is in an onboarding status
// (pending_connect) — per auth.ts, that means the session cookie was
// set on the platform host, not api.headorn.com. Stripe's refresh_url
// and return_url must land back on the same host or resolveTenant()
// below will never find the session cookie. Mirrors platformBase()
// in routes/auth.ts — kept local here rather than shared to avoid
// touching @solostore/shared mid-fix; worth consolidating later.
function platformBase(env: Env): string {
  return env.ENVIRONMENT === 'production'
    ? 'https://headorn.com'
    : 'http://localhost:8789';
}

// ── Shared auth helper ────────────────────────────────────────────────────────
// Returns tenantMeta if session is valid, or a Response to return early.

async function resolveTenant(
  request: Request,
  env: Env
): Promise<{ tenant: TenantMeta; tenantId: string } | Response> {
  const sessionId = parseSessionCookie(request.headers.get('Cookie'));
  if (!sessionId) return json({ error: 'Unauthenticated' }, 401);

  const session = await getSession(env, sessionId);
  if (!session) return json({ error: 'Session expired or invalid' }, 401);

  const tenant = await getTenantMeta(env, session.tenantId);
  if (!tenant) return json({ error: 'Tenant not found' }, 404);

  return { tenant, tenantId: session.tenantId };
}

// ── POST /connect/start ───────────────────────────────────────────────────────
// Creates a Stripe Connect Express account (idempotent),
// stores stripeAccountId + join key in KV, returns onboarding URL.

export async function handleConnectStart(
  request: Request,
  env: Env
): Promise<Response> {
  const result = await resolveTenant(request, env);
  if (result instanceof Response) return result;
  const { tenant, tenantId } = result;

  if (!tenant.stripeCustomerId) {
    return json({ error: 'Platform subscription required before connecting' }, 402);
  }

  // Idempotent — if account already exists, skip creation and just issue a new link
  let accountId = tenant.stripeAccountId;

  if (!accountId) {
    const createRes = await stripePost(env.STRIPE_SECRET_KEY, '/v1/accounts', {
      type: 'express',
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: {
        solostore_tenant_id: tenantId,
        solostore_customer_id: tenant.stripeCustomerId,
      },
      country: 'GB',
      default_currency: 'gbp',
    });

    if (!createRes.ok) {
      const err = await createRes.json() as { error: { message: string } };
      return json({ error: `Stripe error: ${err.error.message}` }, 502);
    }

    const account = await createRes.json() as { id: string };
    accountId = account.id;

    // Persist stripeAccountId and advance status
    const updated: TenantMeta = {
      ...tenant,
      stripeAccountId: accountId,
      status: 'pending_connect',
    };

    await Promise.all([
      // Update tenant record
      env.SOLOSTORE_KV.put(kvKey.tenant(tenantId), JSON.stringify(updated)),
      // Reverse-lookup join key: accountId → tenantId (used by account.updated webhook)
      env.SOLOSTORE_KV.put(kvKey.connectAccountTenant(accountId), tenantId),
    ]);
  }

  // Issue Account Link (expires ~5 min — /connect/refresh handles expiry)
  const linkRes = await stripePost(env.STRIPE_SECRET_KEY, '/v1/account_links', {
    account: accountId,
    refresh_url: `${platformBase(env)}/connect/refresh`,
    return_url: `${platformBase(env)}/connect/return`,
    type: 'account_onboarding',
  });

  if (!linkRes.ok) {
    const err = await linkRes.json() as { error: { message: string } };
    return json({ error: `Stripe error: ${err.error.message}` }, 502);
  }

  const link = await linkRes.json() as { url: string };
  return json({ url: link.url });
}

// ── GET /connect/return ───────────────────────────────────────────────────────
// Stripe redirects here after the merchant completes (or abandons) onboarding.
// We re-fetch account state from Stripe — never trust the redirect alone.

export async function handleConnectReturn(
  request: Request,
  env: Env
): Promise<Response> {
  const result = await resolveTenant(request, env);
  if (result instanceof Response) return result;
  const { tenant, tenantId } = result;

  if (!tenant.stripeAccountId) {
    return json({ error: 'No Connect account found — start onboarding first' }, 400);
  }

  const accountRes = await fetch(
    `https://api.stripe.com/v1/accounts/${tenant.stripeAccountId}`,
    {
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Stripe-Version': '2024-06-20',
      },
    }
  );

  if (!accountRes.ok) {
    const err = await accountRes.json() as { error: { message: string } };
    return json({ error: `Stripe error: ${err.error.message}` }, 502);
  }

  const account = await accountRes.json() as StripeAccount;
  const nextStatus = resolveNextStatus(account, tenant.status);

  if (nextStatus !== tenant.status) {
    const updated: TenantMeta = { ...tenant, status: nextStatus };
    await env.SOLOSTORE_KV.put(kvKey.tenant(tenantId), JSON.stringify(updated));
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${platformBase(env)}/onboarding`,
    },
  });
}

// ── GET /connect/refresh ──────────────────────────────────────────────────────
// Stripe redirects here when the Account Link has expired.
// Issue a fresh one and return it.

export async function handleConnectRefresh(
  request: Request,
  env: Env
): Promise<Response> {
  const result = await resolveTenant(request, env);
  if (result instanceof Response) return result;
  const { tenant } = result;

  if (!tenant.stripeAccountId) {
    return json({ error: 'No Connect account found — start onboarding first' }, 400);
  }

  const linkRes = await stripePost(env.STRIPE_SECRET_KEY, '/v1/account_links', {
    account: tenant.stripeAccountId,
    refresh_url: `${platformBase(env)}/connect/refresh`,
    return_url: `${platformBase(env)}/connect/return`,
    type: 'account_onboarding',
  });

  if (!linkRes.ok) {
    const err = await linkRes.json() as { error: { message: string } };
    return json({ error: `Stripe error: ${err.error.message}` }, 502);
  }

  const link = await linkRes.json() as { url: string };
  return json({ url: link.url });
}

// ── Status resolver ───────────────────────────────────────────────────────────

function resolveNextStatus(
  account: StripeAccount,
  current: TenantMeta['status']
): TenantMeta['status'] {
  const fullyVerified =
    account.details_submitted &&
    account.charges_enabled &&
    account.payouts_enabled;

  if (fullyVerified) {
    const advanceable: TenantMeta['status'][] = ['pending_verification', 'pending_connect'];
    if (advanceable.includes(current)) return 'pending_products';
  }

  return current;
}

// ── Stripe helpers ────────────────────────────────────────────────────────────

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

async function stripePost(
  secretKey: string,
  path: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(`https://api.stripe.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2024-06-20',
    },
    body: toFormEncoded(body),
  });
}

function toFormEncoded(obj: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const encodedKey = prefix ? `${prefix}[${key}]` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      parts.push(toFormEncoded(value as Record<string, unknown>, encodedKey));
    } else {
      parts.push(`${encodeURIComponent(encodedKey)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.join('&');
}