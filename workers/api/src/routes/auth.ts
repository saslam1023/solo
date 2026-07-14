/* workers/api/src/routes/auth.ts */

import { Env } from '../types/env';
import { kvKey } from '@solostore/shared';

import {
  createMagicToken,
  consumeMagicToken,
  createSession,
  getSession,
  deleteSession,
  getTenantMeta,
} from '../lib/auth';

import {
  parseSessionCookie,
  setSessionCookie,
  clearSessionCookie,
} from '@solostore/shared';

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// ── URL helpers ───────────────────────────────────────────────────
//
// Platform lives at headorn.com (one Pages project, path-based):
//   headorn.com/           ← signup
//   headorn.com/onboarding ← post-magic-link setup + Connect
//   headorn.com/admin      ← platform owner admin (Queen's view)
//
// Each merchant tenant lives at:
//   newstore.headorn.com/dashboard  ← merchant's own dashboard
//   newstore.headorn.com/           ← buyer storefront
//
// SECURITY: __Host- prefixed cookies cannot carry a Domain attribute,
// so a session cookie is permanently locked to the exact host that set
// it. Rather than fighting that by trying to share one cookie across
// hosts, we set the cookie on whichever host the browser is ALREADY
// on when /auth/verify runs — which means the magic link itself must
// point straight at the correct destination host. This keeps every
// redirect after verification purely relative (same-origin), which
// means no CORS and no cross-site cookie handling is needed anywhere
// in the merchant dashboard flow.

const MERCHANT_STATUSES = ['pending_products', 'ready', 'live'] as const;
const ONBOARDING_STATUSES = ['pending_verification', 'pending_onboarding', 'pending_connect'] as const;

function platformBase(env: Env): string {
  return env.ENVIRONMENT === 'production'
    ? 'https://headorn.com'
    : 'http://localhost:8789';
}

function tenantOrigin(slug: string, env: Env): string {
  return env.ENVIRONMENT === 'production'
    ? `https://${slug}.headorn.com`
    : `http://${slug}.localhost:8786`; // dev: router on 8786, real subdomain via *.localhost
}

function apiBase(env: Env): string {
  return env.ENVIRONMENT === 'production'
    ? 'https://api.headorn.com'
    : 'http://localhost:8787';
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

// ── POST /auth/magic-link ─────────────────────────────────────────

export async function handleMagicLink(
  request: Request,
  env: Env
): Promise<Response> {
  let email: string;

  try {
    const body = await request.json() as { email?: string };
    email = (body.email ?? '').trim().toLowerCase();
  } catch {
    return json({ error: 'Invalid request body' }, 400);
  }

  if (!email || !email.includes('@')) {
    return json({ error: 'Valid email required' }, 400);
  }

  const safeResponse = json({
    message: 'If an account exists, a login link has been sent.',
  });

  try {
    const stripeRes = await fetch(
      `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`,
      { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
    );

    const stripeData = await stripeRes.json() as {
      data: Array<{ id: string; metadata?: { tenantId?: string } }>;
    };

    if (!stripeData.data?.length) return safeResponse;

    const customer = stripeData.data[0];
    const tenantId = customer.metadata?.tenantId;
    if (!tenantId) return safeResponse;

    const tenant = await getTenantMeta(env, tenantId);
    if (!tenant) return safeResponse;
    if (tenant.status === 'pending_payment') return safeResponse;

    const token = await createMagicToken(env, tenantId);

    // ── Pick the magic link's HOST based on where the session needs
    // to live. This is the fix: verify must run on the same host the
    // dashboard/onboarding UI will load from, or the __Host- cookie
    // never reaches it.
    let linkBase: string;
    if ((MERCHANT_STATUSES as readonly string[]).includes(tenant.status) && tenant.slug) {
      linkBase = tenantOrigin(tenant.slug, env);
    } else {
      linkBase = platformBase(env);
    }

    const magicUrl = `${linkBase}/auth/verify?token=${token}`;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.RESEND_FROM,
        to: [email],
        subject: 'Sign in to your SoloStore dashboard',
        html: `
          <p>Click the link below to sign in to your SoloStore dashboard.</p>
          <p><a href="${escapeHtml(magicUrl)}"
             style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;
                    padding:14px 28px;border-radius:8px;font-weight:600;font-size:15px;">
            Sign in to your store →
          </a></p>
          <p>This link expires in 15 minutes and can only be used once.</p>
          <p>If you didn't request this, you can safely ignore this email.</p>
           <p style="font-size:13px;color:#bbb;margin-top:8px;">
            Can't click? Copy this URL:<br>
            <span style="word-break:break-all;">${escapeHtml(magicUrl)}</span>
          </p>
        `,
      }),
    });

  } catch (err) {
    console.error('magic-link error:', err);
  }

  return safeResponse;
}

// ── GET /auth/verify?token={token} ───────────────────────────────
//
// Runs on whatever host the magic link pointed at (platform host or
// tenant subdomain — decided at send time in handleMagicLink above).
// Because of that, Set-Cookie always applies to the correct host, and
// every redirect below can be a plain relative path — no cross-origin
// cookie handling required.

export async function handleVerify(
  request: Request,
  env: Env
): Promise<Response> {
  const url   = new URL(request.url);
  const token = url.searchParams.get('token') ?? '';

  // Error redirects always point at the platform host, since
  // auth-error.html only exists in pages/platform — it's never
  // served from a tenant subdomain.
  if (!token) {
    return Response.redirect(`${platformBase(env)}/auth-error?reason=missing_token`, 302);
  }
  const payload = await consumeMagicToken(env, token);
  if (!payload) {
    return Response.redirect(`${platformBase(env)}/auth-error?reason=invalid_or_expired`, 302);
  }

  const tenant = await getTenantMeta(env, payload.tenantId);
  if (!tenant) {
    return Response.redirect(`${platformBase(env)}/auth-error?reason=tenant_not_found`, 302);
  }

  const sessionId = await createSession(env, payload.tenantId);

  // Advance status on first-ever verification
  if (tenant.status === 'pending_verification') {
    await env.SOLOSTORE_KV.put(
      kvKey.tenant(payload.tenantId),
      JSON.stringify({ ...tenant, status: 'pending_onboarding' })
    );
  }

  let destination: string;

  if ((ONBOARDING_STATUSES as readonly string[]).includes(tenant.status)) {
    destination = `${platformBase(env)}/onboarding`;
  } else if ((MERCHANT_STATUSES as readonly string[]).includes(tenant.status)) {
    destination = `${tenantOrigin(tenant.slug!, env)}/dashboard`;
  } else {
    destination = `${platformBase(env)}/auth-error?reason=account_closed`;
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: destination,
      'Set-Cookie': setSessionCookie(sessionId, 604800),
    },
  });
}

// ── POST /auth/logout ─────────────────────────────────────────────
//
// Also relative-origin: clears whichever host's cookie the browser
// is actually on (merchant subdomain or platform), consistent with
// how the session was issued.

export async function handleLogout(
  request: Request,
  env: Env
): Promise<Response> {
  const sessionId = parseSessionCookie(request.headers.get('Cookie'));
  if (sessionId) {
    await deleteSession(env, sessionId);
  }

  const url = new URL(request.url);

  return new Response(null, {
    status: 302,
    headers: {
      Location: url.origin,
      'Set-Cookie': clearSessionCookie(),
    },
  });
}

// ── GET /auth/me ──────────────────────────────────────────────────

export async function handleMe(
  request: Request,
  env: Env
): Promise<Response> {
  const sessionId = parseSessionCookie(request.headers.get('Cookie'));
  if (!sessionId) return json({ error: 'Unauthenticated' }, 401);

  const session = await getSession(env, sessionId);
  if (!session) return json({ error: 'Session expired or invalid' }, 401);

  const tenant = await getTenantMeta(env, session.tenantId);
  if (!tenant) return json({ error: 'Tenant not found' }, 404);

  const stripeRes = await fetch(
    `https://api.stripe.com/v1/customers/${tenant.stripeCustomerId}`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
  );

  if (!stripeRes.ok) return json({ error: 'Could not retrieve account details' }, 502);

  const customer = await stripeRes.json() as { email: string; name: string };

  return json({
    tenantId: tenant.id,
    slug:     tenant.slug ?? null,
    status:   tenant.status,
    email:    customer.email,
    name:     customer.name ?? null,
  });
}
