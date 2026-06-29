/* workers/api/src/handlers/orders.ts */

/**
 * Merchant-facing order management API.
 *
 * All routes require merchant session auth (requireAuth).
 * Every KV read is scoped to session.tenantId — never from user input.
 *
 * Routes:
 *   GET  /orders                    List orders (filter by status, paginated)
 *   GET  /orders/:id                Get single order
 *   PATCH /orders/:id/status        Update order status (fulfil or cancel)
 *
 * Security:
 *   - tenantId always from verified session, never from request body/params
 *   - Order ownership verified on every read: order.tenantId === session.tenantId
 *   - Status transitions are strictly enumerated — no arbitrary status values accepted
 *   - Refunds handled via Stripe dashboard; status updated via charge.refunded webhook
 */

import { kvKey } from '@solostore/shared';
import type { Order, OrderStatus } from '@solostore/shared';
import type { Env } from '../types/env';

// ─── Types ────────────────────────────────────────────────────────────────────

const VALID_STATUSES: OrderStatus[] = ['pending', 'paid', 'fulfilled', 'refunded', 'cancelled'];

// Allowed manual status transitions by merchant.
// refunded is set only by webhook (charge.refunded) — never by merchant directly.
const ALLOWED_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = {
  paid:    ['fulfilled', 'cancelled'],
  pending: ['cancelled'],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

class OrderError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof OrderError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  console.error('[orders] Unexpected error:', err);
  return Response.json({ error: 'Internal server error' }, { status: 500 });
}

// ─── GET /orders ──────────────────────────────────────────────────────────────

export async function handleListOrders(
  request: Request,
  env: Env,
  tenantId: string
): Promise<Response> {
  try {
    const url = new URL(request.url);

    // ── Parse and validate query params ──────────────────────────────────────
    const statusFilter = url.searchParams.get('status');
    const limitParam = url.searchParams.get('limit');
    const cursor = url.searchParams.get('cursor') ?? undefined;

    if (statusFilter && !VALID_STATUSES.includes(statusFilter as OrderStatus)) {
      return Response.json(
        { error: `Invalid status filter. Must be one of: ${VALID_STATUSES.join(', ')}` },
        { status: 400 }
      );
    }

    const limit = limitParam ? parseInt(limitParam, 10) : 50;
    if (isNaN(limit) || limit < 1 || limit > 200) {
      return Response.json(
        { error: 'limit must be an integer between 1 and 200' },
        { status: 400 }
      );
    }

    // ── List from KV ──────────────────────────────────────────────────────────
    // We list more than requested so we can filter by status and still
    // return `limit` results. KV list() supports cursor-based pagination.
    const listed = await env.SOLOSTORE_KV.list({
      prefix: kvKey.orderList(tenantId),
      limit: 1000,  // fetch a full page; filter in-process
      ...(cursor ? { cursor } : {}),
    });

    const orders = (
      await Promise.all(
        listed.keys.map(({ name }) =>
          env.SOLOSTORE_KV.get<Order>(name, 'json')
        )
      )
    ).filter((o): o is Order => {
      if (!o) return false;
      // Belt-and-braces ownership check — should always match due to KV prefix
      if (o.tenantId !== tenantId) return false;
      if (statusFilter && o.status !== statusFilter) return false;
      return true;
    });

    // Sort newest first
    orders.sort((a, b) => b.createdAt - a.createdAt);

    // Apply limit after filter
    const page = orders.slice(0, limit);

    return Response.json({
      orders: page,
      total: page.length,
      hasMore: !listed.list_complete || orders.length > limit,
      nextCursor: !listed.list_complete ? listed.cursor ?? null : null,
    });

  } catch (err) {
    return errorResponse(err);
  }
}

// ─── GET /orders/:id ─────────────────────────────────────────────────────────

export async function handleGetOrder(
  _request: Request,
  env: Env,
  tenantId: string,
  orderId: string
): Promise<Response> {
  try {
    const order = await env.SOLOSTORE_KV.get<Order>(
      kvKey.order(tenantId, orderId),
      'json'
    );

    if (!order) {
      return Response.json({ error: 'Order not found' }, { status: 404 });
    }

    // Ownership check — tenantId from session must match order's tenantId
    if (order.tenantId !== tenantId) {
      return Response.json({ error: 'Order not found' }, { status: 404 });
    }

    return Response.json(order);

  } catch (err) {
    return errorResponse(err);
  }
}

// ─── PATCH /orders/:id/status ─────────────────────────────────────────────────

interface UpdateStatusInput {
  status: OrderStatus;
}

export async function handleUpdateOrderStatus(
  request: Request,
  env: Env,
  tenantId: string,
  orderId: string
): Promise<Response> {
  try {
    // ── Parse body ────────────────────────────────────────────────────────────
    let body: UpdateStatusInput;
    try {
      body = await request.json() as UpdateStatusInput;
    } catch {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { status: newStatus } = body;

    if (!newStatus || !VALID_STATUSES.includes(newStatus)) {
      return Response.json(
        { error: `status must be one of: ${VALID_STATUSES.join(', ')}` },
        { status: 400 }
      );
    }

    // ── Load order ────────────────────────────────────────────────────────────
    const order = await env.SOLOSTORE_KV.get<Order>(
      kvKey.order(tenantId, orderId),
      'json'
    );

    if (!order) {
      return Response.json({ error: 'Order not found' }, { status: 404 });
    }

    // Ownership check
    if (order.tenantId !== tenantId) {
      return Response.json({ error: 'Order not found' }, { status: 404 });
    }

    // ── Validate transition ───────────────────────────────────────────────────
    if (order.status === newStatus) {
      return Response.json({ error: `Order is already ${newStatus}` }, { status: 400 });
    }

    const allowed = ALLOWED_TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(newStatus)) {
      return Response.json(
        {
          error: `Cannot transition order from '${order.status}' to '${newStatus}'. ` +
            (allowed.length > 0
              ? `Allowed transitions: ${allowed.join(', ')}`
              : `No transitions allowed from '${order.status}'`),
        },
        { status: 400 }
      );
    }

    // ── Write updated order ───────────────────────────────────────────────────
    const updated: Order = {
      ...order,
      status: newStatus,
      updatedAt: Date.now(),
    };

    await env.SOLOSTORE_KV.put(
      kvKey.order(tenantId, orderId),
      JSON.stringify(updated)
    );

    return Response.json(updated);

  } catch (err) {
    return errorResponse(err);
  }
}