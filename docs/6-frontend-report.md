# Frontend Report — AeyChhotu

What has been built and verified in the AeyChhotu frontend.

## 1. Repository Layout

```
/
├── docs/        # All project documentation (source of truth)
└── frontend/    # Complete Next.js application
    ├── app/           # App Router pages, layouts, API route
    ├── components/    # ui/ layout/ motion/ diner/ staff/ brand/
    ├── hooks/         # use-db, use-presence, use-table-data, use-now, scroll lock
    ├── lib/           # api/ service layer, fonts, format, motion, site, sound, utils
    └── configs        # package.json, tsconfig, next/postcss/eslint configs, .gitignore
```

## 2. Technology

| Item | Choice |
|---|---|
| Framework | Next.js 16.3.6 (App Router, Turbopack) |
| Language | TypeScript (strict), React 19.3 |
| Styling | Tailwind CSS v4 with a single `@theme` token block |
| Animation | `motion` v13 — scroll parallax, reveals, overlays |
| Icons | Lucide React |
| Fonts | `next/font` — Fraunces (display) + Inter (body) |

No additional frameworks; no Bootstrap/MUI/UI kits.

## 3. Screens vs Documented Flows

| Documented flow | Route | Status |
|---|---|---|
| Landing / home | `/` (`(marketing)` route group) | ✅ |
| Diner: scan QR → shared menu, cart, allergy box, Review & Fire | `/table/[token]` | ✅ |
| Diner: live guest tracker (grey → amber → green flash) | `/table/[token]/tracker` | ✅ |
| Chef: PIN gate → KDS kanban (Pending/Preparing/Ready) | `/kitchen` + `POST /api/v1/auth/kds-login` | ✅ |
| Server: floor view, active table tags, quick 86ing panel | `/floor` | ✅ |
| Error / not-found states | `app/error.tsx`, `app/not-found.tsx` | ✅ |

Every endpoint behavior from `docs/4-architectural-mapping.md` (session init, cart add/remove, fire with inventory check, anti-duplicate guardrail, KDS status machine, ticket pruning, availability toggle) is represented in the service layer.

## 4. Design System

- **Tokens:** one `@theme` block in `app/globals.css` holds the Hospitality skin — near-white ground (`#FBF8F4`), white raised surface, espresso ink (`#1C1512`), the `#9E3E14` ember accent, status colors (pending/preparing/ready/alert), type scale, radii, shadows, motion timings. A second, unlayered `[data-skin="ops"]` block enlarges only the ticket type for the kitchen and floor boards, so one selector adapts a whole surface without forking the palette. No hardcoded colors scattered across files.
- **Typography:** editorial clamp-based scale from display → label, wired through `next/font`.
- **Primitives:** reusable components in `components/ui/` (Button, IconButton, Card, Badge, Input, Textarea, Select, Field, Modal, Drawer, Overlay, Tooltip, Toast, Spinner, LoadingState, EmptyState, Container, Section, Heading, Text, PageHeader, SectionHeader…). No duplicated markup between pages.
- **Skins:** `data-skin="ops"` wraps the kitchen and floor surfaces (`kitchen-screen.tsx`, `floor-screen.tsx`). All surfaces share the one Hospitality palette; the ops wrapper only enlarges the ticket type so it reads at distance, and the viewports on both routes report the same light `themeColor`.
- **Removed:** the `components/landscape/` set (LandscapeScene, Sun, OrganicShape, SectionDivider) was unmounted in the palette pass — the diner header and the landing hero were rebuilt around product mocks instead — and has now been deleted along with the unreferenced `public/hero.png`.

## 5. Motion & Parallax

- Entrance reveals via `components/motion/reveal.tsx`, plus status/overlay/card transitions.
- `useReducedMotion` respected in every animated component (reveals, KDS cards, tracker, overlays) — verified in-browser with emulated `prefers-reduced-motion`.
- Transform/opacity-based animation only; no layout-shift effects, no scroll hijacking.

## 6. Data & API Layer

- **One `fetch` call in the whole app** (KDS PIN login). All UI talks to `lib/api/index.ts`, a typed async service layer whose functions mirror the documented endpoints 1:1 and return `ServiceResult` envelopes.
- Typed domain models in `lib/api/types.ts`.
- Data currently resolves from a local seeded store (`lib/api/seed.ts`, `store.ts`) behind the service boundary — ready to be swapped to Supabase without touching UI components.

## 7. Accessibility & States

- Semantic landmarks, `aria-label`s on navs/icons/keypad, `role="status"` spinners, labeled form fields, keyboard-operable PIN keypad, overlays close on Escape with focus handling.
- Loading, empty, and error states exist as dedicated components and are used across screens (e.g. tracker empty state, inactive-table state, custom 404).
- Buttons implement hover/active/disabled/loading variants.

## 8. Build Verification

| Check | Result |
|---|---|
| `npm run typecheck` (tsc --noEmit) | ✅ 0 errors |
| `npm run lint` (eslint) | ✅ 0 errors |
| `npm run build` (production) | ✅ Compiled successfully — 6 routes: `/`, `/floor`, `/kitchen`, `/table/[token]`, `/table/[token]/tracker`, `/api/v1/auth/kds-login` + `_not-found` |
| Dev server log | ✅ no errors or warnings |

## 9. Browser QA (headless Chrome against `next dev`)

**Render sweep — 6 screens × 6 widths (320, 375, 768, 1024, 1280, 1440px) = 36 combos:**

- **0px horizontal overflow on every combo** — no clipped or overlapping content
- No console errors, no page exceptions, no failed resources
- Verified rendered content on: landing, diner menu, live tracker, kitchen PIN wall, floor view, custom 404

**Interaction tests — 9/9 passed:**

- Mobile navigation drawer opens from the hamburger and closes with Escape @375px
- Add-to-cart updates the sticky cart strip; cart opens as a proper `role="dialog"` modal; Escape closes it @375px
- `prefers-reduced-motion` honored — page renders fully with zero overflow @375px
- Kitchen PIN: wrong PIN shows an inline error ("That PIN does not match."); correct PIN unlocks the live KDS board with columns, Start shift and Manage 86 controls @768px
- Floor view exposes the Quick 86 panel control @375px

**One finding:** the site has no favicon yet (no `public/` directory), so the first page load requests `/favicon.ico` and gets a 404 — harmless, browser-cached after first load. Everything else is clean.
