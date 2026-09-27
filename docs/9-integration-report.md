# 9 — Integration Report

**Status: ✅ PASS** (verified 2026-09-28) — frontend build green, end-to-end smoke **18/18**.

## Frontend build
| Check | Result |
|---|---|
| `tsc --noEmit` | ✅ 0 errors |
| `eslint .` | ✅ 0 errors (1 intentional disable documented in `apiClient.ts` 401 redirect) |
| `next build` (16.3.6, Turbopack) | ✅ 6 routes: `/`, `/floor`, `/kitchen`, `/table/[token]`, `/table/[token]/tracker`, `/api/v1/auth/kds-login` |

## Prompt spec → implementation
| Requirement | Where | State |
|---|---|---|
| 4-state matrix (loading / empty / error+Retry / success) | `diner-table-screen` (`DinerSkeleton`, empty menu `EmptyState`+Refresh), `live-tracker` (`TrackerSkeleton`, `ErrorState`), `cart-modal` (empty-cart CTA), `menu-list` (empty catalog), `kds-board` (per-column skeletons, "No active orders on the line! 🍳") | ✅ |
| Review & Fire intercept (disable + spinner + no double-submit + toast + cart reset + server refetch) | `cart-modal.tsx` `firing` guard, `use-live-table.fire` → `FireFailure` + cart/menu refresh | ✅ |
| KDS one-tap intercept | `use-live-kds.busy` per-ticket map; `kds-card` `disabled+loading` button | ✅ |
| `error.fields` inline under inputs | `use-live-table.itemErrors` → `menu-item-row` `role="alert"` line; inventory warning under the item row | ✅ |
| `allergy_note` bold uppercase red on KDS | `kds-card.tsx` (`border-alert`, `font-bold uppercase text-alert`) | ✅ |
| Currency `Rs.` | `lib/format.formatPrice` → `Rs. X,XXX.XX` (invariant: stored unit is rupees; paise migration deferred per standing decision) | ✅ |
| Times in IST | `formatIstTime` / `formatIstDateTime` (`Asia/Kolkata`) — tracker fired label | ✅ |
| REST → `NEXT_PUBLIC_API_URL` | `lib/api-client/apiClient.ts` (20 s timeout, envelope parse, no hardcoded host) | ✅ |
| Realtime via `@supabase/supabase-js` | `realtime.ts` channels: `table_carts:{token}`, `kds_orders`, `order_tracker:{id}`, `table_presence:{token}` | ✅ |
| REST polling fallback | `watchOrderStatus`: REST first paint → channel → 5 s poll while socket not `SUBSCRIBED`; missing env → REST-only; backend down → seeded demo store (`live` source badge) | ✅ |
| Direct workspace writes, shells untouched | All wiring confined to hooks + component logic; Tailwind/layout unchanged | ✅ |

## End-to-end smoke (frontend api-client → live Express `:4000`)
**18/18 PASS** — E2 login `1234` (`role=kitchen`) · E2b `/auth/me` · E1 session `k7x2p` · E3 menu 20/20 · E4 cart · E5 upsert (`total_table_quantity`) · E6 update · E7 remove · **E8 fire 201** · **E8b duplicate 409 `DUPLICATE_ORDER`** · E9 active-check blocked · E16 history · E11 `preparing→ready` · E14 86 off/on · E12 prune → `served` · **E2 wrong PIN 401 `INVALID_PIN`** (contract code; correctly does *not* trip the token-wipe redirect guard).

## Known limits
- Realtime needs `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`; without them the app runs REST + polling, and offline it runs the seeded demo store — the intended "live with mock fallback" ladder.
- Menu availability drawer reads its list from the demo store (E3 menu requires a `table_token`); the toggle itself is live-first (E14).
