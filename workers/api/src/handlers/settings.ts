/* workers/api/src/handlers/settings.ts */

import { Env } from '../types/env';
import {
  kvKey,
  TenantMeta,
  jsonResponse,
  errorResponse,
  isValidSlug,
  isValidCustomDomain,
} from '@solostore/shared';
import Stripe from 'stripe';

// ── Helpers ──────────────────────────────────────────────────────

async function getTenant(env: Env, tenantId: string): Promise<TenantMeta | null> {
  const raw = await env.SOLOSTORE_KV.get(kvKey.tenant(tenantId));
  if (!raw) return null;
  return JSON.parse(raw) as TenantMeta;
}

async function putTenant(env: Env, tenant: TenantMeta): Promise<void> {
  await env.SOLOSTORE_KV.put(kvKey.tenant(tenant.id), JSON.stringify(tenant));
}

function isClosed(tenant: TenantMeta): boolean {
  return tenant.status === 'closed';
}

// ── GET /settings ────────────────────────────────────────────────
//
// Returns only what the merchant needs to manage their own store.
// Never returns stripeCustomerId/stripeAccountId raw — those are
// internal references, not data the frontend needs to render settings.

export async function handleGetSettings(
  request: Request,
  env: Env,
  tenantId: string
): Promise<Response> {
  const tenant = await getTenant(env, tenantId);
  if (!tenant) {
    return errorResponse('Tenant not found', 404);
  }

  return jsonResponse({
    slug: tenant.slug ?? null,
    displayName: tenant.displayName ?? null,
    customDomain: tenant.customDomain ?? null,
    customDomainVerified: tenant.customDomainVerified ?? false,
    status: tenant.status,
    hasStripeConnect: Boolean(tenant.stripeAccountId),
  });
}

// ── PATCH /settings/store ────────────────────────────────────────
//
// Updates slug and/or displayName. Slug changes require a collision
// check against the global slug index and an atomic-as-possible
// swap: write new index entry, update tenant record, delete old
// index entry. If any step fails partway, the tenant record is the
// source of truth for which slug is "current" — the old index entry
// pointing at a stale slug is harmless (it would just fail lookup
// since tenant.slug no longer matches), but we still clean it up.

interface UpdateStoreBody {
  slug?: string;
  displayName?: string;
}

const MAX_DISPLAY_NAME_LENGTH = 80;

export async function handleUpdateStoreSettings(
  request: Request,
  env: Env,
  tenantId: string
): Promise<Response> {
  const tenant = await getTenant(env, tenantId);
  if (!tenant) {
    return errorResponse('Tenant not found', 404);
  }
  if (isClosed(tenant)) {
    return errorResponse('Account is closed', 410);
  }

  let body: UpdateStoreBody;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (body == null || typeof body !== 'object') {
    return errorResponse('Invalid request body', 400);
  }

  const updates: Partial<TenantMeta> = {};

  // ── Display name (cosmetic, low risk) ──
  if (body.displayName !== undefined) {
    if (typeof body.displayName !== 'string') {
      return errorResponse('displayName must be a string', 400);
    }
    const trimmed = body.displayName.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
      return errorResponse(
        `displayName must be between 1 and ${MAX_DISPLAY_NAME_LENGTH} characters`,
        400
      );
    }
    updates.displayName = trimmed;
  }

  // ── Slug (routing-critical, strict validation + collision check) ──
  let oldSlug: string | undefined;
  let newSlug: string | undefined;

  if (body.slug !== undefined) {
    if (typeof body.slug !== 'string') {
      return errorResponse('slug must be a string', 400);
    }
    const candidate = body.slug.trim().toLowerCase();

    if (!isValidSlug(candidate)) {
      return errorResponse(
        'Invalid slug. Use 3-63 lowercase letters, numbers, or hyphens; must not start/end with a hyphen; reserved words are not allowed.',
        400
      );
    }

    oldSlug = tenant.slug;

    if (candidate !== oldSlug) {
      // Collision check — fail closed if the slug is taken by ANY tenant,
      // including a soft-deleted one with a stale index entry still present.
      const existing = await env.SOLOSTORE_KV.get(kvKey.tenantBySlug(candidate));
      if (existing && existing !== tenantId) {
        return errorResponse('Slug is already taken', 409);
      }
      newSlug = candidate;
      updates.slug = candidate;
    }
  }

  if (Object.keys(updates).length === 0) {
    return errorResponse('No valid fields provided', 400);
  }

  const updatedTenant: TenantMeta = { ...tenant, ...updates };

  if (newSlug) {
    // Write new index entry first — if this fails, nothing else has
    // changed and the tenant is still reachable under the old slug.
    await env.SOLOSTORE_KV.put(kvKey.tenantBySlug(newSlug), tenantId);
  }

  await putTenant(env, updatedTenant);

  if (newSlug && oldSlug) {
    // Only remove the old index entry after the tenant record itself
    // has been updated to point at the new slug — avoids a window
    // where both old and new slugs resolve, plus avoids ever deleting
    // the only working index entry before a replacement exists.
    await env.SOLOSTORE_KV.delete(kvKey.tenantBySlug(oldSlug));
  }

  return jsonResponse({
    slug: updatedTenant.slug ?? null,
    displayName: updatedTenant.displayName ?? null,
  });
}

// ── PATCH /settings/domain ───────────────────────────────────────
//
// Sets or removes a custom domain. Format-validated only — no DNS
// lookups performed here (see isValidCustomDomain in shared package
// for rationale). A newly-set domain is always unverified; nothing
// in this handler ever sets customDomainVerified to true. That flag
// is intentionally only flippable by a separate, future verification
// process (e.g. a Cloudflare for SaaS custom hostname webhook/cron),
// so the router never routes traffic to an unverified domain.

interface UpdateDomainBody {
  customDomain?: string | null;
}

export async function handleUpdateDomainSettings(
  request: Request,
  env: Env,
  tenantId: string
): Promise<Response> {
  const tenant = await getTenant(env, tenantId);
  if (!tenant) {
    return errorResponse('Tenant not found', 404);
  }
  if (isClosed(tenant)) {
    return errorResponse('Account is closed', 410);
  }

  let body: UpdateDomainBody;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (body == null || typeof body !== 'object' || !('customDomain' in body)) {
    return errorResponse('customDomain field is required (string or null to remove)', 400);
  }

  const oldDomain = tenant.customDomain;

  // ── Removal ──
  if (body.customDomain === null) {
    if (oldDomain) {
      await env.SOLOSTORE_KV.delete(kvKey.tenantByDomain(oldDomain));
    }
    const updatedTenant: TenantMeta = {
      ...tenant,
      customDomain: undefined,
      customDomainVerified: false,
    };
    await putTenant(env, updatedTenant);
    return jsonResponse({ customDomain: null, customDomainVerified: false });
  }

  // ── Set / change ──
  if (typeof body.customDomain !== 'string') {
    return errorResponse('customDomain must be a string or null', 400);
  }

  const candidate = body.customDomain.trim().toLowerCase();

  if (!isValidCustomDomain(candidate)) {
    return errorResponse('Invalid custom domain format', 400);
  }

  if (candidate !== oldDomain) {
    const existing = await env.SOLOSTORE_KV.get(kvKey.tenantByDomain(candidate));
    if (existing && existing !== tenantId) {
      return errorResponse('Domain is already in use by another store', 409);
    }

    await env.SOLOSTORE_KV.put(kvKey.tenantByDomain(candidate), tenantId);

    const updatedTenant: TenantMeta = {
      ...tenant,
      customDomain: candidate,
      customDomainVerified: false, // always reset on change — re-verification required
    };
    await putTenant(env, updatedTenant);

    if (oldDomain) {
      await env.SOLOSTORE_KV.delete(kvKey.tenantByDomain(oldDomain));
    }

    return jsonResponse({ customDomain: candidate, customDomainVerified: false });
  }

  // No actual change
  return jsonResponse({
    customDomain: tenant.customDomain ?? null,
    customDomainVerified: tenant.customDomainVerified ?? false,
  });
}

// ── DELETE /account ──────────────────────────────────────────────
//
// Soft delete: cancels the Stripe subscription (source of truth for
// billing), flips status to 'closed', stamps closedAt, and removes
// slug/domain index entries so the storefront immediately stops
// resolving (no waiting on a webhook round-trip). The tenant KV
// record itself is left in place — it holds no PII beyond what was
// already in Stripe, only operational/reference data.
//
// FAIL CLOSED on Stripe errors: if subscription cancellation cannot
// be confirmed, the account is NOT closed and nothing is de-routed.
// This is deliberate — silently closing an account while billing
// might still be active would let a merchant believe they've stopped
// being charged when they haven't, and creates a path for abuse
// (e.g. an attacker triggering closure on a victim's tenant via a
// session bug, leaving billing in an unverifiable state). The
// merchant is told to contact support rather than risk this.

export async function handleDeleteAccount(
  request: Request,
  env: Env,
  tenantId: string
): Promise<Response> {
  const tenant = await getTenant(env, tenantId);
  if (!tenant) {
    return errorResponse('Tenant not found', 404);
  }
  if (isClosed(tenant)) {
    return errorResponse('Account is already closed', 410);
  }

  // Cancel the platform subscription in Stripe — Stripe remains the
  // source of truth for billing state; we don't track plan details
  // locally. If this cannot be confirmed, abort the whole closure.
  if (tenant.stripeCustomerId) {
    try {
      const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
        apiVersion: '2026-06-24.dahlia',
      });
      const subscriptions = await stripe.subscriptions.list({
        customer: tenant.stripeCustomerId,
        status: 'active',
        limit: 10,
      });
      const results = await Promise.allSettled(
        subscriptions.data.map((sub) =>
          stripe.subscriptions.cancel(sub.id)
        )
      );
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length > 0) {
        console.error(
          'Stripe subscription cancellation partially failed during account closure',
          { tenantId, failedCount: failed.length }
        );
        return errorResponse(
          'We could not confirm cancellation of your billing subscription. Your account has not been closed. Please contact support so we can resolve this safely.',
          502
        );
      }
    } catch (err) {
      console.error('Stripe subscription cancellation failed during account closure', err);
      return errorResponse(
        'We could not confirm cancellation of your billing subscription. Your account has not been closed. Please contact support so we can resolve this safely.',
        502
      );
    }
  }

  // Remove routing index entries immediately so the storefront stops
  // resolving this tenant right away, without waiting on Stripe webhooks.
  if (tenant.slug) {
    await env.SOLOSTORE_KV.delete(kvKey.tenantBySlug(tenant.slug));
  }
  if (tenant.customDomain) {
    await env.SOLOSTORE_KV.delete(kvKey.tenantByDomain(tenant.customDomain));
  }

  const updatedTenant: TenantMeta = {
    ...tenant,
    status: 'closed',
    closedAt: Date.now(),
  };
  await putTenant(env, updatedTenant);

  return jsonResponse({ status: 'closed', closedAt: updatedTenant.closedAt });
}
