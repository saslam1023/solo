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
      {
        headers: {
          Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        },
      }
    );

    const stripeData = await stripeRes.json() as {
      data: Array<{ id: string; metadata?: { tenantId?: string } }>;
    };


    if (!stripeData.data?.length) {
      console.log('debug: bailing — no customer');
      return safeResponse;
    }

    const customer = stripeData.data[0];
    const tenantId = customer.metadata?.tenantId;

    if (!tenantId) {
      console.log('debug: bailing — no tenantId');
      return safeResponse;
    }

    const tenant = await getTenantMeta(env, tenantId);
    console.log('debug: tenant from KV:', JSON.stringify(tenant));

    if (!tenant) {
      console.log('debug: bailing — tenant not in KV');
      return safeResponse;
    }

    if (tenant.status === 'pending_payment') {
      console.log('debug: bailing — pending_payment');
      return safeResponse;
    }

    const token = await createMagicToken(env, tenantId);
    const baseUrl = env.ENVIRONMENT === 'development'
      ? 'http://localhost:8787'
      : 'https://api.solostore.co.uk';

    const magicUrl = `${baseUrl}/auth/verify?token=${token}`;

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.RESEND_FROM,
        to: [email],
        subject: 'Your Solostore login link',
        html: `
          <p>Click the link below to log in to your Solostore dashboard.</p>
          <p><a href="${magicUrl}">Log in to Solostore</a></p>
          <p>This link expires in 15 minutes and can only be used once.</p>
          <p>If you didn't request this, you can safely ignore this email.</p>
        `,
      }),
    });

    const resendData = await resendRes.json();
    console.log('debug: Resend response:', JSON.stringify(resendData));

  } catch (err) {
    console.error('magic-link error:', err);
  }

  return safeResponse;
}

// ── GET /auth/verify?token={token} ───────────────────────────────

export async function handleVerify(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') ?? '';

  if (!token) {
    return Response.redirect('/auth-error?reason=missing_token', 302);
  }

  const payload = await consumeMagicToken(env, token);

  if (!payload) {
    return Response.redirect('/auth-error?reason=invalid_or_expired', 302);
  }

  const tenant = await getTenantMeta(env, payload.tenantId);

  if (!tenant) {
    return Response.redirect('/auth-error?reason=tenant_not_found', 302);
  }

  const sessionId = await createSession(env, payload.tenantId);

  const redirectMap: Record<string, string> = {
    pending_verification: '/onboarding',
    pending_onboarding:   '/onboarding',
    pending_connect:      '/onboarding/connect',
    pending_products:     '/admin/products',
    ready:                '/admin',
    live:                 '/admin',
  };

  const destination = redirectMap[tenant.status] ?? '/admin';

  if (tenant.status === 'pending_verification') {
    await env.SOLOSTORE_KV.put(
      kvKey.tenant(payload.tenantId),
      JSON.stringify({ ...tenant, status: 'pending_onboarding' })
    );
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

export async function handleLogout(
  request: Request,
  env: Env
): Promise<Response> {
  const sessionId = parseSessionCookie(request.headers.get('Cookie'));

  if (sessionId) {
    await deleteSession(env, sessionId);
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: '/',
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

  if (!sessionId) {
    return json({ error: 'Unauthenticated' }, 401);
  }

  const session = await getSession(env, sessionId);

  if (!session) {
    return json({ error: 'Session expired or invalid' }, 401);
  }

  const tenant = await getTenantMeta(env, session.tenantId);

  if (!tenant) {
    return json({ error: 'Tenant not found' }, 404);
  }

  const stripeRes = await fetch(
    `https://api.stripe.com/v1/customers/${tenant.stripeCustomerId}`,
    {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    }
  );

  if (!stripeRes.ok) {
    return json({ error: 'Could not retrieve account details' }, 502);
  }

  const customer = await stripeRes.json() as {
    email: string;
    name: string;
  };

  return json({
    tenantId: tenant.id,
    slug: tenant.slug,
    status: tenant.status,
    email: customer.email,
    name: customer.name,
  });
}