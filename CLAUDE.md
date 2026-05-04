# CLAUDE.md

This file is automatically read by Claude Code at the start of every session.

## Project: nailiq

A salon booking and receptionist management web app for nail salons. Two surfaces:
- **Public booking** at `/[slug]` — customers pick service, staff, date/time, and contact info; no app install required.
- **Receptionist + owner dashboard** at `/dashboard/[slug]/...` — real-time booking grid, queue management, salon setup (services, staff, hours, address), settings.

Primary market is Vietnam (Vietnamese + English UI, phone formats 8–15 digits with country codes). B2C with salons as direct customers.

## 🛠️ Tech Stack

- **Framework**: Next.js 16.2 (App Router) + React 19.2
- **Language**: TypeScript 5 (strict)
- **Styling**: Tailwind CSS v4 (CSS-first config via `@theme` — no `tailwind.config.js`)
- **Animations**: Framer Motion 12 + canvas-confetti
- **Database & Auth**: Supabase (`@supabase/ssr` 0.10, `@supabase/supabase-js`)
- **Error Monitoring**: Sentry (`@sentry/nextjs` 10) — separate configs for browser, Node, edge
- **Testing**: Playwright 1.59 (E2E)
- **Package Manager**: npm
- **Hosting**: Vercel

## 📁 Project Structure

All app code lives under `src/`. There is no top-level `app/` or `lib/`.

```
src/
├── app/                       # Next.js App Router
│   ├── [slug]/                # Public booking page (force-dynamic)
│   ├── register/              # OTP signup flow: phone → verify → setup → success
│   ├── dashboard/[slug]/
│   │   ├── center/            # Receptionist center: realtime booking grid + queue
│   │   ├── setup/             # Multi-step wizard: address, hours, services, staff
│   │   └── settings/          # Salon settings (pause bookings, etc.)
│   ├── debug-sentry/          # Manual Sentry error trigger
│   ├── layout.tsx, globals.css
│   └── middleware.ts          # Auth + Sentry tagging (also at src/middleware.ts)
├── components/
│   ├── booking/               # Public booking UI
│   ├── receptionist/          # Center grid, drawer, queue, undo toast
│   ├── dashboard/             # Setup wizard, settings forms
│   ├── register/              # OTP, salon-name entry
│   ├── layout/, user/, ui/    # Shared layout, landing, primitives (Button, Input, Toast)
├── shared/
│   ├── lib/supabase/          # Three Supabase clients (see below)
│   ├── lib/                   # salonTime.ts, phoneFormat.ts, formatting helpers
│   ├── booking/               # Public booking server actions, conflictCheck.ts
│   ├── dashboard/             # setupActions, salonOwnerActions, receptionistActions, editBookingAction
│   ├── register/              # OTP actions, phone validation, registerSessionKeys.ts
│   ├── i18n/                  # Vi/En copy
│   ├── seo/                   # JSON-LD, metadata helpers
│   └── types/
├── instrumentation.ts         # Routes Sentry init by NEXT_RUNTIME (node|edge)
├── middleware.ts              # Supabase session refresh, demo cookie, Sentry tags
└── sentry.{server,edge}.config.ts

e2e/                           # Playwright (~22 spec files)
├── helpers/db.ts              # seedTestSalon / cleanupTestSalon (uses service-role client)
├── booking*.spec.ts           # booking, validation, security
├── register.spec.ts
├── dashboard.spec.ts
└── receptionist-center/       # Bulk of coverage: realtime, edit, conflict, queue, drawer, ...

supabase/migrations/           # Versioned SQL migrations
scripts/auto-push.js           # File-watching auto-commit/push (see below)
docs/                          # Design notes, receptionist mockups
.github/workflows/             # CI
sentry.client.config.ts        # Browser Sentry init (root, not under src/)
```

## 🔑 Coding Conventions

1. **TypeScript strict** — no `any`, use `unknown` and narrow.
2. **Server Components by default** — only add `"use client"` for interactivity (forms, motion, listeners). Most pages and components are server.
3. **Server Actions for ALL mutations** — there are no REST API routes. Mutations live in `src/shared/{booking,dashboard,register}/*.ts` and are called from client components via `useTransition()` or directly from server components.
4. **Three Supabase clients** (in `src/shared/lib/supabase/`):
   - `client.ts` → `createBrowserClient()` from `@supabase/ssr` — for client components, realtime listeners.
   - `server.ts` → `createServerClient()` from `@supabase/ssr`, wires `cookies()` — default for server components and server actions; respects RLS.
   - `serviceRole.ts` → `createClient()` from `@supabase/supabase-js` with `SUPABASE_SERVICE_ROLE_KEY` — bypasses RLS. **Server-only.** Used for OTP rows, registration tokens, and test seeding.
5. **Tailwind v4** — CSS-first config (`@theme` blocks in `globals.css`). Do not create `tailwind.config.js`.
6. **Imports**: `@/` alias is configured. Group: external → internal → types.
7. **Files**: `kebab-case.tsx` for routes/files; `PascalCase` for components; `camelCase` for functions.
8. **Sentry tagging**: middleware sets `salon.slug` and `surface` tags — keep these on any new request-handling code path that needs traceability.

## 🗄️ Supabase Tables

Referenced via `.from()` calls across the codebase:
- `salons` — salon profile (slug, name, phone, timezone, address, hours, booking-paused flag)
- `salon_members` — user ↔ salon with role: `owner` | `senior` | `nail_tech`
- `services` — per-salon menu (name, duration, price)
- `staff` — staff members and availability
- `bookings` — customer bookings (date, time, services, status, client info)
- `client_profiles` — returning customers (name, phone, email)
- `otps` — registration OTPs
- `register_completion_tokens` — short-lived tokens passed across `/register/*` steps

Database types: `lib/database.types.ts` (auto-generated). Migrations: `supabase/migrations/`. RLS is expected on all tables; enforce salon-membership checks server-side regardless.

## 🧠 Domain Logic Hotspots

These modules are load-bearing and easy to break — read before editing:
- `src/shared/lib/salonTime.ts` — local salon time ↔ UTC conversion. Bookings store UTC; UI shows salon-local.
- `src/shared/lib/phoneFormat.ts` and `src/shared/register/phone.ts` — multi-region phone parsing/validation.
- `src/shared/booking/conflictCheck.ts` — double-booking prevention. Custom business logic, NOT RLS-enforced.
- `src/shared/booking/queueUrgency.ts` — receptionist queue ordering.

## 🔒 Security Rules

- NEVER expose `SUPABASE_SERVICE_ROLE_KEY` to client. It only goes through `serviceRole.ts` in server-only code paths.
- NEVER expose `SENTRY_AUTH_TOKEN` to client.
- NEVER commit `.env*` files. The `.claude/hooks/protect-secrets.sh` PreToolUse hook blocks any Bash command referencing `.env`, plus Read of `.env|.pem|.key|id_rsa|credentials`.
- All mutating server actions MUST verify the caller is a member of the target salon (lookup via `salon_members`) — RLS is a backstop, not the only check.
- Customer-facing inputs (booking name, etc.) are sanitized — see commit `0181cf2` for the allowlist approach.

## 📋 Workflow Rules

1. **Before starting**: read this file. For non-trivial work, also explore the relevant `src/shared/<feature>/` actions and `e2e/<feature>.spec.ts` to understand contracts.
2. **After completing a task**:
   - `npm run typecheck` — TypeScript check.
   - `npm run build` — production build.
   - `npm run test:e2e` (or the relevant spec) for UX-affecting changes.
   - Commit with conventional commits (`feat(scope):`, `fix(scope):`). Recent history shows `feat(receptionist):`, `fix(integrity):`, `fix(security):` patterns.
3. **When stuck**: stop and explore — don't guess. Ask the user.
4. **Architectural decisions**: log in `docs/decisions.md`.

## 🧪 Testing

- **Run all E2E**: `npm run test:e2e`
- **UI mode**: `npm run test:e2e:ui`
- **Debug**: `npm run test:e2e:debug`
- **Last report**: `npm run test:e2e:report`

Tests hit a real Supabase (test DB) via the service-role client. `e2e/helpers/db.ts` provides `seedTestSalon()` / `cleanupTestSalon()`. The `receptionist-center/` folder has the deepest coverage — model new tests on it.

## 🚀 Custom Scripts

- `npm run auto-push` → `scripts/auto-push.js`. Watches the repo with `chokidar` (ignoring `.next`, `node_modules`, `.git`, `logs`); on any change debounces 30 s, infers a commit message from the changed paths (`update styles`, `update landing UI`, `update copy and i18n`, `update <file>`, or `auto update`), then runs `git add . && git commit && git push`. **Footguns**: any save triggers a commit; no typecheck/build/test gate; will push broken code; spams history. Gated behind a permission prompt — only run when the user explicitly asks.

## 🌐 External Services

- **Supabase**: DB + Auth. Keys in `.env.local`.
- **Sentry**: three runtime configs (browser at `sentry.client.config.ts`, server/edge at `src/sentry.*.config.ts`). Sampling: 1.0 dev, 0.2–0.25 prod. `src/instrumentation.ts` dispatches by `NEXT_RUNTIME`.
- **Vercel**: auto-deploy from `main`.

## 🚫 Never Do

- Don't add REST API routes — use server actions.
- Don't change the tech stack (Next 16, React 19, Supabase, Tailwind v4, Framer Motion).
- Don't bypass `salon_members` membership checks in server actions.
- Don't store secrets in `localStorage`.
- Don't skip Zod / runtime validation on user-supplied input.
- Don't deploy without `npm run build`.
- Don't downgrade React 19 / Next 16.

## ⚠️ Known Tech Debt / Gotchas

- **Registration uses `sessionStorage`** (`src/shared/register/registerSessionKeys.ts`) to carry completion tokens between `/register/*` steps. Doesn't survive reload, breaks across tabs. Phase-2 candidate to move to server-side state.
- **Phase-2 TODOs**:
  - `src/shared/booking/submitPublicBooking.ts:10` — "Phase 2 WOW" placeholder.
  - `src/shared/dashboard/addEmailAction.ts:36,39` — email verification via Resend not yet wired.
- **Demo OTP mode**: `NEXT_PUBLIC_DEMO_OTP` + `NAILQ_DEMO_SLUG_COOKIE` allow bypassing real auth in dev/test. Verify it's off in prod.
- **Conflict checking is application-level**, not enforced by DB constraints — be careful when touching `conflictCheck.ts` or booking insert paths.
- **Two middleware locations**: `src/middleware.ts` is the active one. Don't add a second one in `src/app/`.

## 📚 Related Files

- `package.json` — dependencies (read-only context).
- `next.config.ts` — currently shows as deleted in git status; verify before assuming config.
- `playwright.config.ts` — Playwright config.
- `sentry.client.config.ts`, `src/sentry.{server,edge}.config.ts` — Sentry configs.
- `.env.local` — secrets. **Do not read.** Hook will block it.

---

> When in doubt, explore the codebase first. Don't assume — verify.
