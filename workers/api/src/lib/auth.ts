import { Env } from '../types/env';
import { kvKey, TenantMeta } from '@solostore/shared';

// ── Token generation ──────────────────────────────────────────────

export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function generateSessionId(): string {
  return generateToken();
}

// ── Magic link ────────────────────────────────────────────────────

export async function createMagicToken(
  env: Env,
  tenantId: string
): Promise<string> {
  const token = generateToken();
  await env.SOLOSTORE_KV.put(
    kvKey.magicToken(token),
    JSON.stringify({ tenantId, createdAt: Date.now() }),
    { expirationTtl: 900 }
  );
  return token;
}

export async function consumeMagicToken(
  env: Env,
  token: string
): Promise<{ tenantId: string } | null> {
  const key = kvKey.magicToken(token);
  const raw = await env.SOLOSTORE_KV.get(key);
  if (!raw) return null;

  try {
    await env.SOLOSTORE_KV.delete(key);
  } catch {
    return null;
  }

  const data = JSON.parse(raw) as { tenantId: string };
  return data;
}

// ── Sessions ──────────────────────────────────────────────────────

export async function createSession(
  env: Env,
  tenantId: string
): Promise<string> {
  const sessionId = generateSessionId();
  await env.SOLOSTORE_KV.put(
    kvKey.session(sessionId),
    JSON.stringify({ tenantId, createdAt: Date.now() }),
    { expirationTtl: 604800 }
  );
  return sessionId;
}

export async function getSession(
  env: Env,
  sessionId: string
): Promise<{ tenantId: string } | null> {
  const raw = await env.SOLOSTORE_KV.get(kvKey.session(sessionId));
  if (!raw) return null;
  return JSON.parse(raw) as { tenantId: string };
}

export async function deleteSession(
  env: Env,
  sessionId: string
): Promise<void> {
  await env.SOLOSTORE_KV.delete(kvKey.session(sessionId));
}

// ── Tenant lookup ─────────────────────────────────────────────────

export async function getTenantMeta(
  env: Env,
  tenantId: string
): Promise<TenantMeta | null> {
  const raw = await env.SOLOSTORE_KV.get(kvKey.tenant(tenantId));
  if (!raw) return null;
  return JSON.parse(raw) as TenantMeta;
}