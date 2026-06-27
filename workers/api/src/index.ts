/* workers/api/src/index.ts */
import { Env } from './types/env';
import {
  handleMagicLink,
  handleVerify,
  handleLogout,
  handleMe,
} from './routes/auth';
import { handleRegister } from './handlers/register';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    // ── Registration (public, no auth) ────────────────────────────
    if (path === '/register' && method === 'POST') {
      return handleRegister(request, env);
    }

    // ── Auth routes ───────────────────────────────────────────────
    if (path === '/auth/magic-link' && method === 'POST') {
      return handleMagicLink(request, env);
    }

    if (path === '/auth/verify' && method === 'GET') {
      return handleVerify(request, env);
    }

    if (path === '/auth/logout' && method === 'POST') {
      return handleLogout(request, env);
    }

    if (path === '/auth/me' && method === 'GET') {
      return handleMe(request, env);
    }

    // ── 404 ───────────────────────────────────────────────────────
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};