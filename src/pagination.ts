/**
 * Auto-pagination helper for list endpoints.
 *
 * The BillKit API returns Stripe-shape envelopes:
 *
 *     { "object": "list", "data": [...], "has_more": bool }
 *
 * Cursor pagination is forward-only via the last item's `id` as
 * `starting_after`. `paginate` walks every page and yields each row.
 * Callers consume it via `for await`:
 *
 *     for await (const customer of client.customers.iter()) {
 *       ...
 *     }
 */

import type { QueryValue } from "./transport.js";

export interface ListResponseEnvelope<T = unknown> {
  readonly data?: readonly T[];
  readonly has_more?: boolean;
}

export interface PaginateOptions {
  /** Maps to the API's `limit` parameter. `undefined` lets the
   *  server pick its default (10 today). */
  pageSize?: number | undefined;
  /** Extra filters forwarded on every page (e.g. `type` on events,
   *  `action` on audit logs). Values are pruned of `undefined` so
   *  callers can spread their full options object in. */
  filters?: Readonly<Record<string, QueryValue>>;
}

type ListFn<T> = (params: {
  limit?: number | undefined;
  starting_after?: string | undefined;
  [key: string]: QueryValue;
}) => Promise<ListResponseEnvelope<T>>;

/**
 * Walk every page of `listFn` and yield each row.
 *
 * Three terminators, in priority order:
 *   1. `has_more=false`: the server's authoritative signal (common case).
 *   2. Empty `data` with `has_more=true`: shouldn't happen per the API
 *      contract, but if a future server bug or proxy misbehaviour
 *      produced it the iterator would loop forever. Belt-and-suspenders.
 *   3. The last row has no `id`, so there is no cursor to advance with. The schema
 *      doesn't allow it today, but same defensive reasoning.
 */
export async function* paginate<T>(
  listFn: ListFn<T>,
  options: PaginateOptions = {},
): AsyncIterableIterator<T> {
  const { pageSize, filters } = options;
  const cleanFilters: Record<string, QueryValue> = {};
  if (filters) {
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined) cleanFilters[k] = v;
    }
  }

  let cursor: string | undefined;
  for (;;) {
    const page = await listFn({
      ...cleanFilters,
      limit: pageSize,
      starting_after: cursor,
    });
    const items = page.data ?? [];
    for (const item of items) yield item;
    if (!page.has_more || items.length === 0) return;
    const last = items[items.length - 1] as { id?: string } | undefined;
    cursor = last?.id;
    if (cursor === undefined) return;
  }
}
