# NailIQ — Project Brain

Living document. Update after significant changes so sessions can resume with shared context.

## Vision

NailIQ is the AI-first operating system for nail salons and beauty businesses: one place to run the front door, the chair, the till, and growth.

## Product Positioning

- **What it is:** An integrated platform (web + operations + AI) built for salon owners, staff, and clients—not a generic booking widget bolted onto spreadsheets.
- **Who it is for:** Multi-location and ambitious single-location businesses that want speed, brand consistency, and automation without enterprise complexity.
- **Differentiation:** AI-native workflows (menu understanding, try-on, booking assistance), multi-tenant and multi-region readiness, and a premium product feel.

## Core Principles

- **AI-first, human-clear:** Automate the tedious; keep owners in control of policy and brand.
- **Speed and clarity:** Clean UI, short paths to value, no clutter.
- **Multi-tenant by design:** Isolation, permissions, and scalability are assumed from day one—not retrofitted.
- **Mobile reality:** Large share of use is on phone; design and test accordingly.

## Architecture Rules

- Modular boundaries: feature areas communicate through clear interfaces, not ad hoc coupling.
- **No hardcoding** salon-specific or tenant-specific data in shared code.
- **APIs and data access** belong outside render paths; no fetches in render.
- Favor **shared components and tokens** over one-off styles and copy-paste UI.
- **Storage and randomness** (e.g. `localStorage`, `Math.random`) are not used in ways that break SSR, hydration, or render purity where the stack requires it.
- **Language (PROMPT #008) — not global i18n:** User-facing app UI (owner / dashboard / marketing) supports **English (default) and Vietnamese** with copy in `src/shared/i18n/user/` (`en.ts`, `vi.ts`) and a small hook `src/shared/lib/useUserLanguage.ts` (preference in `localStorage` key `nailiq-user-lang`, `EN | VI` toggle, fallback **English**). **Public booking** at `/[shop]` is **English only** — copy in `src/shared/i18n/booking/en.ts`, no locale toggle, no auto-detect, no user-locale import; `BookingDocumentEn` forces `html` `lang` to `en` on that route. **Do not** mix user strings into booking or auto-translate booking.
- Guard against **memory leaks** and **infinite loops** in effects, subscriptions, and state updates.

## Authentication (production path)

- **Supabase Auth** with **phone OTP** on the client (`signInWithOtp` / `verifyOtp`) when **Phone** is enabled in the Supabase project; session cookies via **`@supabase/ssr`** (`src/shared/lib/supabase/server.ts`, `src/shared/lib/supabase/client.ts`).
- **`src/middleware.ts`** refreshes the session on each matched request and **redirects unauthenticated users** away from `/dashboard/*` to `/register`.
- **Tenant link:** `public.salon_members` maps `auth.users` → `salons` (migration `supabase/migrations/20260428120000_salon_members_owner_rls.sql`). Owners complete registration in **`completeSalonRegistration`** (`src/shared/register/completeSalonRegistrationAction.ts`), which inserts the salon, seed row, and membership using the **service role** where needed.
- **RLS:** Authenticated users read/update **their salon’s bookings** through policies that consult `salon_members`; anonymous public booking insert path unchanged.
- **Demo OTP:** When **`NEXT_PUBLIC_DEMO_OTP=true`** (local only — do **not** set on Vercel production), `sendRegisterOtp` / `verifyDemoRegisterOtp` use the `otps` table plus an admin **password bridge** to open a real session (`src/shared/register/demoAuthBridge.ts`) and **`DemoOtpModal`** shows the code on screen.

## Brand System (locked — PROMPT #012)

- **Role:** The **NailIQ** wordmark is a **brand anchor only**—not the hero, not the main attention. The **hero headline (`h1`)** is always the visual and semantic focus. **CTA** is second in priority: strong contrast and visibility. Brand is **distributed** (header wordmark, small card badge, optional footer “Powered by”, subtle copy) so users feel the brand without an oversized logo.
- **Apple minimalism (PROMPT #015) — hero:** **Product-first:** show **one headline** and **one short subline** in the visible hero. **Phone** (`PhoneFrame`) is **centered in its column** and must be **see without scrolling** on typical phones (tight padding, `head` → `aside` before `rest`). **Less text, more product, more calm emotion.** The long **SEO** paragraph stays **screen-reader–only** (`sr-only`); below-the-fold sections still carry full detail. Primary CTA line is a single string (e.g. EN: “🚀 Get booked in 2 minutes”); no separate short/long mobile CTA.
- **Marketing layer (PROMPT #017) — do not break UI:** The landing **keeps the same layout tokens** (grids, gaps, CTA and input size). It **adds** only: an **urgency** one-liner under the CTA (subtle `nq-urgency-breathe` fade, muted type); **live social proof** (rotating muted two-line set above the value card, 2.6s interval, `fade-in` on change); **phone mock** polish inside `PhoneFrame` (active-scale interaction, service **highlight** pill + `fade-in` on rotate, 2.4s strip interval; optional **+1 booking** micro line under the hero activity card, `fade-in` on activity tick). The mental model remains **urgency + proof + product-first**—elegant, not spam. **Default expectation:** new marketing work should preserve **all three** (light-touch urgency, social-style proof, dominant product) without a layout redesign.
- **Logo type (landing):** Mobile `text-base`–`text-lg`, desktop `text-lg`–`text-xl`, `font-medium` or `font-semibold`, subtle gold or white. Do **not** use `text-2xl` or larger for the wordmark, do not center it as a hero, do not add heavy glow. Keep **≥ 16px** vertical separation from the headline (`space-y-4` or equivalent).
- **Color:** **Primary (gold) `#D4AF37`** — use **sparingly** for CTA, highlight, and focus. **Background `#0B0C10`**, **surface `#111214`**, **text `#FFFFFF`**, **muted `#A1A1AA`**. Maintain contrast; do not flood surfaces with gold.
- **Feel:** **Calm, premium, confident**—Apple-like clarity, not loud, not salesy. Avoid gratuitous neon, flashy all-over gradients, and excessive motion. `text-shimmer` and glass utilities are for **optional accents** (e.g. a single keyword), not for the wordmark as a competing hero.
- **Typography:** `h1` = main selling message (largest, boldest in the hero). `h2` = section titles. Body = readable, muted for secondary. Logo line stays **smaller than `h1`** and never competes with it.
- **Source of truth:** `src/shared/theme/tokens.ts` (`colors` + JSDoc) and `src/app/globals.css` `@theme` / `:root` mirror the same hex values.

## iPhone hero polish (PROMPT #014) + product-first (PROMPT #015)

- **Real-device testing:** Mobile landing hero was tuned for Safari on iPhone: **smaller mobile H1** than desktop, **tighter vertical rhythm**, **wordmark** as a **subtle anchor** (`text-sm`–`text-base`, gold at ~70% opacity, **not** competing with `h1`). **#015:** Hero is **not** a paragraph stack—**headline + one subline** only, then **phone**, then CTA and input.
- **CTA copy:** Single primary line in **en.ts** / **vi.ts** as **`cta`** (e.g. “🚀 Get booked in 2 minutes” / VI equivalent). No separate `ctaMobile` (removed in #015).
- **Phone preview:** **PhoneFrame** sits **immediately after** the minimal hero copy (`head` → `aside` → `rest`) with **subtle gold glow** on all viewports, **`fade-in`** on the hero, and **mild parallax** on the phone (off when `prefers-reduced-motion`). **#015:** Slightly more compact `PhoneFrame` max width on the smallest viewports to keep the device in the first viewport. `lg+`: **head + rest** in column one, **aside** column two, row-span (**MarketingPhoneAside** is the device column only). **#024** / **#025** hero path unchanged (staged service → time → live booking). **Scroll-linked scenes (2026-04-25):** first two benefits carry `data-nq-benefit-scene` for **Booking** and **AI Genesis**; `useDocumentPhoneScene` switches **hero** vs **booking** vs **AI**; **framer-motion** for scene motion. **Booking scene** is a **3-step flow** (service → time → confirmation) with **horizontal slides**, gold CTAs, Navy card, **home indicator**, tap scale; i18n via `phoneBookingCopy` plus `serviceStrip` / `phoneTimeSlots`. Optional **AI menu demo** (local image, gold laser, then sample rows from i18n, not tenant data). **Status bar** (time / signal / battery) on device chrome. `prefers-reduced-motion` reduces motion; hero chain skipped when static highlight path applies. **Device shell** has Navy surface + **thin gold** edge via `nq-*` tokens.
- **Input:** Placeholder only in the field (no pre-filled value); no secondary hint line in the **hero** block. Stays **≥16px** (`text-base`) to avoid iOS focus zoom. **safe area:** `MobileStack` **`pb-safe`**. `ResponsiveShell` uses **tighter** vertical padding on the smallest screens to protect above-the-fold **phone** visibility.

## Design System Rules

- **Aesthetic:** iPhone-like clarity, **premium dark UI**, **gold accent** `#D4AF37` (sparingly—see Brand System).
- **Apple-level UI system (PROMPT #006):** **Liquid glass** — CSS utilities `glass` / `glass-strong` (blur + light tint + gold border) and `glow-gold` in `src/app/globals.css`; **optional motion** — `text-shimmer` (never on the wordmark as hero; optional single-keyword accent), `fade-in` for light motion; **phone mock** — `animate-nq-phone-tick` (#024) and `animate-nq-activity` with **subtle scale** on the booking card (#025). **Ambient** — fixed top gold wash on home (subtle). **Landing phone** also uses **framer-motion** for scene cross-fades and the AI **menu demo** laser; core UI elsewhere stays **CSS + Tailwind** by default. `prefers-reduced-motion` tones down shimmer, fades, and ambient motion. `Button` and `PhoneFrame` are client components; the **hero** in-phone path uses a **chained `setTimeout`** loop (cleaned on unmount), not a random interval, for the staged service/time/booking flow.
- **Feel:** Clean, fast, high contrast where needed, generous spacing, readable type. Premium and calm, not aggressive.
- **Colors:** No hardcoded colors scattered across the app; use design tokens or shared theme values (locked palette in Brand System).
- **Layout:** Mobile-first; scale up for tablet and desktop deliberately.
- **Responsive adaptive UI (PROMPT #007 + #014):** Shared layout primitives in `src/components/layout/`: `ResponsiveShell` (viewport-height shell, horizontal clip, theme padding, vertical center on `lg+` with scroll-safe `justify-start` on small screens), `MobileStack` (iPhone-tight `max` width, `pb-safe`, optional `stickyCta` slot with safe-area bottom), `DesktopSplit` (`head` / `aside` / `rest`: on **mobile** stacks **hero → PhoneFrame → CTA & rest**; on **`lg+`** two columns, **head+rest** left, **aside** right). Foundation home uses `MobileStack` + `DesktopSplit` in one page tree (no separate apps). Breakpoints and layout numbers live in `src/shared/theme/tokens.ts` (`breakpoints`, `layout`) and mirror `--max-nq-*` / `--pad-nq-*` in `globals.css`. `html`/`body` use `overflow-x: hidden` + `pb-safe` utilities for notched devices. Touch: primary CTA `size="lg"` (56px), inputs keep ≥48px. Desktop preview: larger `PhoneFrame` + soft gold wash behind the device; headline scales `lg+`. See *iPhone hero polish* for mobile fine-tuning.

## Current Modules

- **Design foundation** — `src/shared/theme/tokens.ts`, `src/app/globals.css`, UI in `src/components/ui/`, layout `ResponsiveShell` / `MobileStack`. **Marketing home** — `src/components/user/HomeLanding.tsx` at `/` (EN/VI via `useUserLanguage`); nav includes **Owner Login** → `/register` and a compact **Get started** CTA; secondary sign-in line under the phone field. **SEO** — `src/shared/seo/`, `robots.ts`, `sitemap.ts`, `public/ai.txt`, `public/llms.txt`. **i18n** — `src/shared/i18n/user/` + `src/shared/i18n/booking/en.ts` (booking English-only). See **Authentication** for owners.
- **Registration** — `/register` → `/register/verify` → `/register/setup` (server-gated by session) → `/register/success`. Transient phone digits in **`sessionStorage`** (`registerSessionKeys.ts`), not dashboard-gating `localStorage`.
- **Owner dashboard** — `/dashboard/[slug]` via `salonOwnerActions` (session + RLS). Phone masked in UI; booking reference uses `formatNailiqBookingRef`.
- **Public booking** — `src/app/[shop]/page.tsx`, `BookingFlow` + `submitPublicBooking` in `src/shared/booking/`.

## Future Modules (major)

- **Website** — marketing and conversion surfaces.
- **Booking** — availability, services, and scheduling.
- **Staff** — roles, schedules, and permissions.
- **POS** — checkout, services, and payments at the counter.
- **CRM** — clients, history, and retention.
- **AI** — menu scan, nail try-on, booking assistant, and future assistants.
- **Automation engine** — rules, triggers, and workflows.
- **Analytics** — operations and growth metrics.
- **Viral / referral** — growth and share mechanics.
- **Multi-salon / multi-country** — tenants, regions, and compliance-friendly structure.

## Data Flow (high level)

1. **Client / staff / owner** use web (and later native or PWA) against **one app shell**.
2. **Authentication and tenant context** determine what data and UI are visible.
3. **Domain APIs** serve bookings, catalog, users, and analytics; the UI consumes them through a thin **client layer** (hooks, stores, or server actions—exact stack TBD in code).
4. **AI features** call dedicated services or model endpoints; results merge into existing flows (e.g. booking, catalog) without duplicating source of truth.
5. **Automation and analytics** read from the same system of record, not from shadow databases unless explicitly designed.

## SEO + AI Discovery Strategy

- **SEO-ready from the beginning:** Global defaults and per-route `metadata` in the App Router; `metadataBase`, Open Graph, Twitter card, `robots`, keywords, and title template on the root layout.
- **AI-readable content:** Marketing copy and headings are plain text in the HTML (no SEO-critical text only inside animation); landing adds a semantic `h1`, intro paragraph, and `h2`/`h3` benefit blocks alongside the existing layout.
- **Metadata for public pages:** Home (`/`), high-urgency marketing (`/aggressive`), register stub (`/register`), and public booking stub (`/[shop]`) export metadata; future salon pages should use **dynamic metadata from salon data**.
- **Structured data:** Shared JSON-LD (`SoftwareApplication`, `Organization`, `WebSite`) injected on the landing page via `application/ld+json`.
- **Discovery files:** `public/ai.txt` and `public/llms.txt` describe NailIQ for AI crawlers and tools; `src/app/robots.ts` and `src/app/sitemap.ts` expose crawl rules and URL list (`/`, `/register` for now).
- **Canonical URL:** Set `NEXT_PUBLIC_SITE_URL` in deployed environments so `metadataBase`, sitemap, and JSON-LD `@id` values match production.

## Known Risks

- Scope creep across “full OS” features before core flows are shippable.
- Multi-tenant and regional rules (data residency, tax, payments) need explicit decisions as modules appear.
- AI features depend on data quality, permissions, and cost controls—must be designed with guardrails.

## Decisions Log

*(Empty — see [DECISIONS.md](./DECISIONS.md) for structured entries. Summaries or pointers can be mirrored here if useful.)*

## Auto Push System (PROMPT #013)

- **Purpose:** While developing, optionally run `npm run auto-push` to **automatically commit and push** after file saves—without typing git commands on every small edit.
- **Behavior:** A **chokidar** file watcher (ignores `.next`, `node_modules`, `.git`, `logs`) **debounces 30 seconds** from the last change, then runs `git status` and only **commits and pushes** if there are real changes. **One push at a time**; if changes arrive during a push, a follow-up is scheduled. Commit messages are short heuristics (e.g. styles, landing UI) when they match changed paths, otherwise **`auto update`**.
- **Deploy:** Pushes to the current branch; **Vercel** (or your host) can **auto-deploy** from the remote so you can test on iPhone (or other devices) shortly after a push.

## Next Steps

- Keep **PROJECT_BRAIN.md**, **CHANGELOG.md**, and **ROADMAP.md** in sync with reality.
- Complete **Phase 0 (Foundation)** per [ROADMAP.md](./ROADMAP.md) before large feature work.
- When implementation starts, list **current modules** above and link to key folders or packages.
