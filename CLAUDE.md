# CLAUDE.md

This file is automatically read by Claude Code at the start of every session.

## Project: nailiq

A salon booking and receptionist management web app for nail salons. Two surfaces:
- **Public booking** at `/[slug]` — customers pick service, staff, date/time, and contact info; no app install required.
- **Receptionist + owner dashboard** at `/dashboard/[slug]/...` — real-time booking grid, queue management, salon setup (services, staff, hours, address), settings.

Primary market is Vietnam (Vietnamese + English UI, phone formats 8–15 digits with country codes). B2C with salons as direct customers.

## 📐 Architecture Constitution

Before writing ANY UI component or server action, read ALL files in docs/.
Start with docs/ARCHITECTURE_LOCK.md.

Key rules:
- Reuse src/components/ui/ — never invent new primitives
- Never create colors outside docs/COLOR_TOKENS.md
- Never create spacing outside docs/DESIGN_SYSTEM.md
- Never create animation outside docs/ANIMATION_RULES.md
- Never bypass docs/STATE_MACHINE.md transitions
- Never bypass docs/PERMISSION_MATRIX.md checks
- Never move the 3-zone dashboard layout

When in doubt: stop, re-read docs/, ask PM.

## Foundation Freeze (as of 07/05/2026)
src/components/ui/ contains 10 locked primitives:
Button, Card, Badge, Toggle, Drawer, Modal,
KPIWidget, QueueChip, BookingCard, StaffAvatar.

Rules:
- NEVER create a new primitive without PM approval
- NEVER duplicate these components elsewhere
- ALWAYS import from src/components/ui/
- ALWAYS extend via props/variants, not new files

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
│   └── proxy.ts               # Auth + Sentry tagging (also at src/proxy.ts)
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
├── proxy.ts                   # Supabase session refresh, demo cookie, Sentry tags
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
8. **Sentry tagging**: proxy sets `salon.slug` and `surface` tags — keep these on any new request-handling code path that needs traceability.

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
3. **When stuck — docs-first, không đoán mò**:
   - Đọc log nguyên văn → xác định symptom chính xác
   - Tìm evidence: docs chính thức → GitHub issues → changelog của tool
   - Có evidence → áp dụng fix đó. Không thử random approaches.
   - 3 lần thất bại liên tiếp → dừng, báo: `log + link docs tìm được + 2 hướng có evidence`
4. **Architectural decisions**: log in `docs/decisions.md`.
5. **Analyze before implement** — với mọi yêu cầu, tự hỏi 4 câu trước khi code:
   - **UX fit?** Người dùng (salon owner / receptionist / customer) có thấy tiện không?
   - **Modern standard?** Đúng chuẩn Next.js 16 / React 19 / Supabase SSR chưa?
   - **Wow?** Có cách nào hay hơn mà không tốn thêm nhiều effort?
   - **Safe?** Có rủi ro RLS bypass / data loss / regression E2E không?
   → Nếu thấy approach tốt hơn → đề xuất 1 dòng + lý do, chờ OK.
6. **Parallel execution** — task độc lập nhau → chạy song song, không tuần tự:
   - Explore codebase + Research docs + Analyze existing pattern → 3 agents cùng lúc
   - Viết nhiều file không liên quan → multi Write/Edit trong 1 message
   - `typecheck` + `build` không phụ thuộc nhau → parallel Bash calls
   - Sequential chỉ khi có dependency rõ ràng (migration chưa xong, schema chưa có)

## 🔬 Deep Analysis — BẮT BUỘC trước khi implement feature mới

Với mọi feature/module mới, tự chạy 6 chiều phân tích trước khi viết code:

**1. Core** — tối thiểu để feature hoạt động đúng với salon workflow

**2. Wow** — gì khiến salon owner / receptionist / customer "ồ hay quá"
- Micro-interaction có ý nghĩa (không animation vô nghĩa)
- AI auto-fill / smart suggestion
- Realtime feedback tức thì (<100ms)
- Mobile gesture-friendly (receptionist dùng tablet)

**3. UX 2025+**
- Mobile-first: touch target ≥44px, no hover-only interactions
- Skeleton loading > spinner; optimistic UI > wait then show
- Empty state có hướng dẫn — không bao giờ để màn hình trắng trơn
- Dark mode support (dashboard users work long hours)

**4. Failure modes đặc thù NailIQ** — top lỗi phải phòng từ architecture:

| Failure | Root cause | Phòng ngay từ đầu |
|---|---|---|
| Double booking | conflictCheck.ts là app-level, không phải DB constraint | Optimistic lock + DB unique constraint backup |
| Timezone mismatch | UTC stored, salon-local shown | Luôn dùng `salonTime.ts`, không dùng `new Date()` trực tiếp |
| RLS bypass | server action không verify salon_members | Mọi mutation check membership trước RLS |
| Realtime race | Supabase Realtime + server action mutate cùng lúc | Idempotent actions + version field |
| E2E flaky | Async Supabase ops không await đủ | Explicit wait + seedTestSalon cleanup |

**5. Scalability** — khi salon có 100+ bookings/ngày:
- Query nào sẽ N+1? Index đã có chưa?
- Realtime subscription: bao nhiêu concurrent channels?

**6. Security**
- `salon_members` check trong mọi server action (RLS là backstop, không phải primary)
- `serviceRole.ts` chỉ dùng server-only path
- User input → Zod validate trước khi insert

## ⚡ Self-learning — rút kinh nghiệm từ lỗi

**Sau mỗi bug fix không hiển nhiên** (tốn 2+ lần thử):
1. Tạo / cập nhật `~/.claude/projects/-Users-huytran-nailiq/memory/gotcha_<topic>.md`:
   - **Symptom**: lỗi nhìn thấy ra sao
   - **Root cause**: tại sao xảy ra
   - **Fix**: đã làm gì
   - **Prevention**: test/check gì để không xảy ra lần sau
2. Cập nhật `MEMORY.md` với 1 dòng pointer.

**Trước khi implement**: scan `MEMORY.md` → có gotcha liên quan không? Nếu có, đọc trước.

**Quy tắc 3 lần**: thấy pattern tương tự lần 3 → extract thành module tái sử dụng trong `src/shared/`, không copy-paste lần 4.

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

- **Registration sessionStorage + server-side fallback**: keys defined in `src/shared/lib/registerSessionKeys.ts`; `RegisterPageClient` and `VerifyPageClient` still write/read sessionStorage as the primary path. PR #72 (2026-05-09) added `src/shared/register/loadRegisterFlowStateAction.ts` — a server-side fallback that resolves register flow state from `register_completion_tokens` so reloads / cross-tab don't dead-end. Full migration off sessionStorage is future work; for now both code paths exist and you must keep them in sync.
- **Phase-2 returning-customer WOW** — `src/shared/booking/submitPublicBooking.ts:513` carries a TODO to use `client_profiles` lookup at phone entry for auto-fill name + suggest preferred staff + "Welcome back" greeting. Not V1-blocking; activate when first beta salons report friction.
- **Demo OTP mode**: `NEXT_PUBLIC_DEMO_OTP` + `NAILQ_DEMO_SLUG_COOKIE` allow bypassing real auth in dev/test. Verify it's off in prod.
- **Conflict checking is application-level**, not enforced by DB constraints — be careful when touching `conflictCheck.ts` or booking insert paths.
- **Single proxy entry**: `src/proxy.ts` is the active one. Don't add a second one in `src/app/`.

## 📚 Related Files

- `package.json` — dependencies (read-only context).
- `next.config.ts` — currently shows as deleted in git status; verify before assuming config.
- `playwright.config.ts` — Playwright config.
- `sentry.client.config.ts`, `src/sentry.{server,edge}.config.ts` — Sentry configs.
- `.env.local` — secrets. **Do not read.** Hook will block it.

## 🤝 PM Workflow
- PM uses Claude.ai as Tech Lead — prompts are pre-written there
- Always run npm run build before opening PR
- Always apply DB migrations to prod via Supabase MCP in same PR
- Open PR as draft, PM reviews and merges manually
- One PR per logical change

---

> When in doubt, explore the codebase first. Don't assume — verify.
