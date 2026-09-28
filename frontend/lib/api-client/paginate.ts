/* Pagination walker for the contract's list endpoints (docs/7 §1.5).

   Why this exists: every list endpoint caps `limit` at 100, and the app
   used to request page 1 only — so menu item 101 or ticket 101 simply
   never rendered anywhere, with no error. `fetchAllPages` keeps asking
   for the next page until `meta.total_pages` is reached, with a hard
   safety cap so a buggy `total` can never spin forever. */

import type { PageMeta } from "./types";

/** Result shape shared by every paginated wrapper (data + meta). */
export interface PagedResult<T> {
  data: T[];
  meta: PageMeta;
}

/** 20 pages × 100 rows = 2 000 rows — far past any real menu, cart or
    active board, and enough to stop a broken meta from looping. */
export const MAX_PAGE_FETCHES = 20;

/** Fetches page 1, then every remaining page, and concatenates `data`. */
export async function fetchAllPages<T>(
  fetchPage: (page: number) => Promise<PagedResult<T>>,
): Promise<T[]> {
  const first = await fetchPage(1);
  const rows = [...first.data];

  let page = 1;
  while (page < first.meta.total_pages && page < MAX_PAGE_FETCHES) {
    page += 1;
    const next = await fetchPage(page);
    if (next.data.length === 0) break; // defensive: empty page ⇒ stop
    rows.push(...next.data);
  }

  return rows;
}
