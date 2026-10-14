/**
 * Auto-pagination for list endpoints. Internal: every resource exposes it
 * as `iter()`, which takes exactly the filters its `list()` takes.
 *
 * The API returns Stripe-shape pages, `{ object: "list", data, has_more }`,
 * and pagination is forward-only via the last row's `id` as
 * `starting_after`.
 */

import type { ListResponse } from "./generated/models.js";

interface PageParams {
  limit?: number | undefined;
  starting_after?: string | undefined;
}

/**
 * Walk every page and yield each row.
 *
 * `params.limit` is the page size and `params.starting_after` the cursor to
 * start from, exactly as on `list()`; every other key is a filter carried
 * onto each page.
 *
 * Three terminators, in priority order:
 *   1. `has_more: false`, the server's authoritative signal.
 *   2. An empty `data` with `has_more: true`. The API never sends it, but a
 *      proxy that did would otherwise loop forever.
 *   3. A last row with no `id`, which leaves no cursor to advance with.
 */
export async function* autoPage<T, P extends PageParams>(
  fetchPage: (params: P) => Promise<ListResponse<T>>,
  params: P,
): AsyncGenerator<T, void, undefined> {
  let cursor = params.starting_after;
  for (;;) {
    const page = await fetchPage({ ...params, starting_after: cursor });
    const items = page.data ?? [];
    for (const item of items) yield item;
    if (!page.has_more || items.length === 0) return;
    const last = items[items.length - 1] as { id?: unknown } | undefined;
    if (typeof last?.id !== "string") return;
    cursor = last.id;
  }
}
