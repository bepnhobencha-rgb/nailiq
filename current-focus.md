# Current Focus
> Last updated: 2026-05-10 (Sun, end of week 5/5–5/11)
> ⚠️ Update mỗi Monday morning. Sửa file local → re-upload Project.

---

## North Star Q2 2026 (ends 30/6/2026)

**3 paying salons với credit card on file trước 30/6/2026.**

Lý do chọn metric này:
- Paying = real validation, không phải vanity metric
- 3 = đủ học pattern, không quá ambitious với 4 tuần dev còn lại
- 0 → 1 paying = step khó nhất, lock trong Q2 forces validation sớm

Trade-off đã chấp nhận: KHÔNG chọn "Ship V1 by date" vì shipping không phải value, paying là value.

## Launch target

- **V1 launch**: ~30/5/2026 (4 tuần từ hôm nay)
- **First paying customer target**: 15/6/2026
- **3 paying salons target**: 30/6/2026

## This week (5/5 — 11/5/2026)

### Task 1: External services setup — START TODAY ⚠️ BLOCKING
**Why critical**: Approval timelines không thể accelerate bằng code. Twilio A2P 10DLC mất 1-3 tuần. Nếu không start tuần này → 3 tuần sau coded xong nhưng không thu được tiền và không gửi được SMS.

Sub-tasks:
- [ ] Apply Stripe account, submit business docs — *code wired 2026-05-09: #73 subscription tiers, #74 plan limits. Awaiting business docs submission.*
- [ ] Twilio A2P 10DLC brand registration + campaign setup — *status TBD; no code dependency.*
- [ ] Domain verification cho transactional email (Resend) — *code wired 2026-05-09: #71 recovery-email verification via Resend. DNS records status TBD.*
- [ ] Google OAuth — Supabase Auth URL Configuration fix — *code wired (login + register + /auth/callback handler). Verified 2026-05-09: Site URL still pointing at vercel.app, needs update to https://nailiq.ca + add `/auth/callback` to Redirect URLs allow-list. Cowork prompt drafted.*

Estimate: 3-4h tuần này (chủ yếu form filling, đợi async).

---

### Task 2: Walk-in queue MVP end-to-end ✅ DONE
**Why critical**: H3 differentiator trong product.md. Nếu V1 chỉ có appointment booking như Booksy → no moat.

Sub-tasks:
- [x] Add walk-in customer to queue (no appointment needed)
- [x] Assign / request specific technician
- [x] Estimated wait time calculation
- [x] Notify when ready (display first, SMS sau khi Twilio approved)

- Completed 2026-05-02. Receptionist Center V1 shipped: route `/dashboard/[slug]/center`, walk-in queue + assign + grid + realtime + drawer. 47/47 e2e pass. Manual iPhone verified.

Estimate: 3-4 ngày code.

---

### Task 3: Beta user pipeline outreach
**Why critical**: Non-coding work mà solo dev hay skip. Nếu launch 30/5 mà chưa biết 5 salon nào sẽ install → wasted 4 tuần.

Sub-tasks:
- [ ] Build list 20 Vietnamese salon owner US/Canada (FB groups, Yelp, Zalo network)
- [ ] Tạo 1-pager pitch + beta access offer
- [ ] DM 10 trong 20 → goal 5 confirmed beta interest

Estimate: 2-3h spread trong tuần. Conversion typical 10-20%, nên 20 DMs → ~3-5 yes.

## Next sprint (5/12 — 5/18/2026)

Massive 5/9 ship day pulled forward most code-side V1 features. Remaining sprint focus:

### Track A — V1 launch path (highest priority, blocking)

- **Task A1:** Unblock external services — Stripe business docs, Twilio A2P 10DLC application, Resend DNS records, Supabase Auth URL config (Cowork prompt ready).
- **Task A2:** Beta user pipeline outreach — list 20 salons, DM 10, target 5 confirmed.
- **Task A3:** Public marketing site (last code-side V1 item).
- **Task A4:** First beta salon install rehearsal — dogfood end-to-end (register → setup wizard → walk-in → reports).
- **Task A5:** E2E CI stabilization — PR #85 (diagnostics) merged → identify hung specs → follow-up fix PR.

### Track B — Superadmin Foundation Shell V1 (concurrent, non-blocking)

PM-approved 2026-05-10. ADR in [decisions-log.md](decisions-log.md). Governance amendments: [PERMISSION_MATRIX.md §8](docs/PERMISSION_MATRIX.md), [DASHBOARD_LAYOUT_RULES.md §10](docs/DASHBOARD_LAYOUT_RULES.md).

**Strict guardrail**: Track A always overrides Track B. If V1 launch blockers (auth / queue / E2E / Twilio / Stripe / Resend) regress → pause Track B immediately, resume only when Track A is green.

**Scope (in)**: auth + protected routes + shell layout + sidebar + salon list/detail (read-only) + impersonation foundation (real cookie swap, audit, banner) + audit log structure + feature flags minimal + announcements minimal + disabled module placeholders for Phase 2/3 routes.

**Scope (out, deferred to Phase 2/3)**: AI Ops, rollout engine, advanced analytics, risk engine, churn prediction, live ops, billing infrastructure beyond minimal flags, fake metrics, speculative backend systems.

| Phase | Scope | Est | Status |
|---|---|---|---|
| 1A | DB schema + RLS (`superadmins.role`, `superadmin_audit_logs`, `platform_feature_flags`, `platform_announcements`) | 2-3h | Pending governance PR merge |
| 1B | Auth surface — `/superadmin/login` + role gate | 3-4h | Pending 1A |
| 1C | Shell + sidebar + ~30 disabled-module routes | 4-5h | Pending 1B |
| 1D | Salon list + detail (read-only) | 4-5h | Pending 1C |
| 1E | Impersonation foundation (founder-only) | 4-6h | Pending 1D |
| 1F | Feature flags + announcements minimal admin | 2-3h | Pending 1E |

**Total estimate**: ~20-25h ≈ 3 days focused, spread across 5-7 calendar days.

**Pre-flight**: 4 governance docs amended (this PR), PR #85 (E2E diagnostics) merged, Queue assign bug reproduced or deferred to V1.1.

Detailed sub-tasks TBD Monday morning (5/11).

## Failure modes — pre-launch checklist

Identified 2026-05-02 in failure mode review. Pre-launch BLOCKERS shipped in commit 637fd37.

**DONE:**
- **Q1 Desk edit booking (pending/confirmed only)** ✅ 2026-05-03 — Receptionist drawer **Edit** → `EditBookingForm` (time/staff/service); server `editBooking` + `performEditBooking` (`editBookingCore.ts`); conflict via `checkBookingConflict` + `excludeBookingId`; status guard blocks `in_progress` / completed / cancelled / waiting; i18n `receptionist.edit.*`; e2e `edit-booking.spec.ts` (5 cases × 2 projects) + smoke `editBooking.smoke.ts` (5); full Playwright suite **73 passed / 1 skipped** after `moveMouseToAssignSlot` focus stabilization. ADR: `decisions-log.md` 2026-05-03.
- **1.1 Service delete with active references** ✅ 2026-05-02 — Proactive booking count check before delete; `service_in_use` error mapped via i18n; `ServicesSetupPanel` localized; e2e `service-delete.spec.ts` 4/4 PASS.
- **1.2 Staff delete with active bookings** ✅ 2026-05-02 — Proactive active booking count check; terminal bookings (cancelled/completed) detached via UPDATE staff_id=NULL before delete; client_profiles.preferred_staff_id cleared; ADR logged in decisions-log.md; e2e `staff-delete.spec.ts` 4/4 PASS.
- **2.3 Public booking RPC race with walk-in** ✅ 2026-05-02 — `create_public_booking` v2.3 (migration 20260502130000) tightened blocking statuses to NOT IN ('cancelled','waiting'); raises `slot_conflict` errcode 23P01; BookingFlow handles via i18n `slotJustTaken`; e2e `public-booking-race.spec.ts` 4/4 PASS + smoke 3/3.
- **6.3 Empty salon banner** ✅ 2026-05-02 — Setup-incomplete banner with smart CTA (services empty → /setup/services, staff empty → /setup/staff); WalkinAddForm disabled when isSetupIncomplete; e2e `empty-salon.spec.ts` 4/4 PASS.

**Deferred to post-launch:**
- **1.3 Timezone selector in onboarding** — Default 'America/Los_Angeles' acceptable for ~60% target salons (West Coast Vietnamese community hub). Onboarding UI for timezone select can ship V1.1.
- **3.3 Demo cookie 24h expiration** — Security audit task; demo cookie currently no explicit expiry. Separate from feature shipping; address in security pass post-launch.

## In progress (carried over)

### MVP build status
- Stack: Next.js 16.2.4, TypeScript clean
- ✅ Dashboard core
- ✅ i18n setup (Vietnamese + English)
- ✅ Booking domain models (`dashboardBookingMap.ts`, `bookingIdsEqual.ts`)
- ✅ Health check passed 2026-05-02 (typecheck + build + e2e 16/16 + manual smoke test public booking + dashboard)
- ✅ Receptionist Center V1 `/dashboard/[slug]/center` — shipped 2026-05-02; manual iPhone verified; iPad Case 7 deferred (see P3).
- ✅ Q1 desk edit booking — **DONE 2026-05-03** (Edit in drawer for pending/confirmed; see pre-launch checklist + `decisions-log.md`).
- ✅ Walk-in queue MVP (queue, assign, grid, drawer, realtime/poll — Receptionist Center V1)
- ❌ Walk-in **polish** beyond MVP desk (SMS notify, EWT, etc.)
- ✅ Stripe subscription integration — code shipped 2026-05-09 (#73 tiers, #74 plan limits). Blocking on Stripe account verification.
- ❌ SMS reminders (sau khi Twilio approved)
- ✅ Onboarding flow — shipped 2026-05-09 (#76 persistent sidebar shell, #77 sidebar follow-ups, #78 wizard refinement, #79 force-wizard gate via `salons.setup_wizard_completed_at`)
- ✅ Reports & analytics — shipped 2026-05-09 (#70)
- ✅ Client profiles panel — shipped 2026-05-09 (#69)
- ✅ Week-view calendar — shipped 2026-05-09 (#68)
- ✅ Audit event log + owner viewer — shipped 2026-05-09 (#65)
- ✅ NailIQ Error Monitor observability + health endpoint + error boundary — shipped 2026-05-09 (#66)
- ✅ Google OAuth wiring (UI + callback handler) — shipped 2026-05-09; Supabase URL config fix pending
- ❌ Public marketing site (week 4)

### Active investigation
None.

## Recently shipped
[Pre-launch — chưa public ship. Update khi có release.]

### Massive ship day — 2026-05-09 (15 PRs merged)

| # | Title | Cluster |
|---|---|---|
| #65 | feat(audit): booking event log + owner-only viewer (#038) | Insight |
| #66 | feat(observability): NailIQ Error Monitor events + spans + health + error boundary (#039) | Infra |
| #67 | chore(proxy): Next 16 convention audit (#040) | Infra (clears P3 middleware deprecation) |
| #68 | feat(receptionist): week view calendar (#041) | Insight |
| #69 | feat(dashboard): client profiles panel + page (#042) | Insight |
| #70 | feat(dashboard): reports & analytics (#043) | Insight |
| #71 | feat(email): salon recovery-email verification via Resend (#044) | Infra |
| #72 | feat(register): server-side flow state alongside sessionStorage (#045) | Infra (partial migration off sessionStorage) |
| #73 | feat(dashboard): subscription tiers via Stripe (#046) | Monetization |
| #74 | feat(plans): enforce staff + service limits on add (#047) | Monetization |
| #75 | fix: QA report 2026-05-09 (BUG-01..20) | QA bug bash — 20 bugs |
| #76 | feat(dashboard): persistent left sidebar + mobile bottom-bar app shell | Onboarding/Shell |
| #77 | feat(dashboard): sidebar follow-ups (calendar deep-link, queue scroll, salon switcher) | Onboarding/Shell |
| #78 | fix(onboarding): clearer wizard, i18n recovery banner, button-like checklist | Onboarding |
| #79 | feat(onboarding): force-wizard gate (closes ⚠️ Partial from #78) | Onboarding |

## Parking lot (DO NOT BUILD V1)
> Reference từ product.md. Activate triggers ghi rõ.

| Item | Trigger to revisit |
|------|---------------------|
| **Desk: add service (multi-service)** — N:N or service array vs V1 replace-one | **5+** beta salons explicit ask → schema work (~2–3d); ADR: `decisions-log.md` 2026-05-03 afternoon |
| **Smart conflict suggestions** (“Mai 3pm busy; try Trang 3pm / Mai 4pm”) | **3+** beta complain conflict UX; skip if owners adapt to flat error (~2–3d engine) |
| **Custom price override** on booking (toggle off auto-price) | **2+** beta ask (~1–2h) |
| Multi-location dashboard | 30+ active salons + 10+ paying + 1 customer ask |
| POS / Payment processing native | After $5k MRR + customer ask |
| Native mobile app | After web validates demand + $10k MRR |
| Marketing automation | After 50+ paying customers |
| Inventory tracking | (separate product, không revisit) |
| AI / smart scheduling | After $1k MRR |
| Loyalty / rewards program | After customer ask 3 times |
| Middleware → proxy migration | Post-launch tech debt |

## Active bugs

### P0/P1
None known.

### P2 (defer post-launch)
- Hydration mismatch ở `SalonOwnerDashboardMain.tsx:199` — ĐÃ FIX 2026-05-02 (single source of truth qua `getSiteUrl()`, không còn fallback `window.location.origin`)
- RPC `suggest_salon_slugs_by_similarity` missing trong DB — feature "did you mean?" khi user typo URL không hoạt động. Console log: `Could not find the function public.suggest_salon_slugs_by_similarity(p_input) in the schema cache`. Fix = apply migration hoặc tạo lại function.
- Migration drift giữa local `supabase/migrations/` và linked DB `schema_migrations`. `supabase db push --linked` fail với "Remote migration versions not found in local migrations directory". Symptoms: trùng timestamps `20260430180000` / `20260430240000`, lệch version `20260428`, remote chỉ tới `20260430200000`. Receptionist migration `20260502120000_receptionist_center_schema.sql` apply qua `db query --linked -f` (không qua schema_migrations log). Resolve trước V1 launch (30/5) để có repeatable deployment. Likely fix: rebase local migrations theo remote state, hoặc `supabase migration repair`.

### P3 (lint debt — defer post-launch)
Tổng 18 ESLint errors, 0 functional impact. Build pass, typecheck pass, Playwright e2e 73 passed / 1 skipped (2026-05-03 baseline). Xem decision 2026-05-02 trong decisions-log.md.

- ~~**Next.js 16 deprecation (middleware → proxy):**~~ ✅ DONE 2026-05-09 (#67 — `chore(proxy): Next 16 convention audit`).
- 12 lỗi `react-hooks/set-state-in-effect` (React 19 rule): `BookingFlowDatePanel`, `BookingReturningGreeting`, `useBookingFlowState` (5 chỗ), `SalonOwnerDashboard`, `Toast`, `HomeLanding`
- 2 lỗi `react-hooks/refs` (access ref during render): `SetupDeleteConfirm`, `Toast`
- 1 lỗi `react-hooks/preserve-manual-memoization`: `BookingFlowDonePanel`
- 1 lỗi `react/no-unescaped-entities`: `SalonBookingNotFound` (trivial)
- 3 lỗi require() imports trong `scripts/auto-push.js` (dev script, không production)
- **Receptionist Center — manual QA cosmetic (defer):** conflict/error toast uses state name `shakeMessage` but **no shake animation** in CSS; spec called for “red shake”. Optional polish post-launch.
- Receptionist Center Case 7 manual iPad test deferred — no device available 2026-05-02. Test on first beta salon iPad install (target: week of 19-25/5).
- **Form buttons — migrate to shared `Button` (foundation):** **Status:** Foundation done **2026-05-03** — `Button.loading` prop added; **`WalkinAddForm`** submit + **`BookingDetailDrawer`** primary/cancel migrated to shared `Button`. **Remaining:** **9** backlog surfaces listed under `.cursorrules` → **FORM BUTTONS** → **Known gaps** (plus `SaveButton.tsx` exception — consolidate later). **Trigger:** refactor when next touching each file (no standalone sprint). **Visual changes accepted:** submit + primary buttons **`rounded-full`** pill; danger uses **solid red** bg; cancel/dismiss styling per **`text-nq-bg`** where applied.
- **`SalonOwnerTodayBookings` hydration mismatch (time display):** Observed **2026-05-03** during e2e runs. Pre-existing, not caused by recent button work. Investigate and fix when touching that component or before V1 launch QA.

### Receptionist Center V1 — final manual QA (14 cases)
**Status:** **Shipped 2026-05-02.** Automated (2026-05-03): `tsc`, `next build`, Playwright **73 passed / 1 skipped** (mobile ghost hover case 11 skipped; `moveMouseToAssignSlot` uses slot `focus()`), dashboard smokes (`loadReceptionistCenterData`, `receptionistActions`, `publicBookingConflict`) — PASS; desk edit: `edit-booking.spec.ts` + `editBooking.smoke.ts`. **Task 5 (empty salon):** setup-incomplete banner + disabled walk-in form; **`e2e/receptionist-center/empty-salon.spec.ts`**. Manual iPhone on `/dashboard/{slug}/center`: PASS (**tel:** opens Phone app). **Case 7 iPad layout** deferred — no device; target first beta salon iPad (week of 19–25/5, see P3). Residual linked-dev cases (dual-tab realtime spot-checks, screenshots) optional for beta trail.

## Decisions cần làm tuần này
- [x] Free trial length: 7 ngày hay 14 ngày? → **14 ngày** (decision 2026-05-02)
- [x] Stripe pricing tiers — implemented in #73 (verify in code if exact pricing/annual flag are set as intended).
- [ ] Beta pricing: free 1 tháng, hay $9 founding member rate, hay full $29?

## External blockers
- Stripe account approval (1-2 ngày sau submit) — code ready (#73, #74)
- Twilio A2P 10DLC approval (1-3 tuần sau registration) — no code yet (SMS reminders deferred until approval)
- Resend domain verification (vài giờ) — code ready (#71)
- Supabase Auth URL Configuration update — pending Cowork run / manual click (Site URL → nailiq.ca, add nailiq.ca/auth/callback to Redirect allow-list)

## Capacity check tuần này
- **Capacity**: Full
- **Focus split**: 70% code (Task 2) / 20% admin (Task 1) / 10% outreach (Task 3)
- **Avoid tuần này**: middleware migration, polish UI, dark mode, mobile optimization
- **Risk**: scope creep từ "I'll just clean up X while I'm in this file" — REJECT

## Quarter milestones (Q2 2026)

| Week of | Milestone | Status |
|---------|-----------|--------|
| 5/5 | External services setup, walk-in queue done, 5 beta interest confirmed | Walk-in ✅ (5/2). External services + beta confirms TBD. **Bonus: 15-PR ship day on 5/9 pulled forward most of weeks 12/5 + 19/5 scope.** |
| 12/5 | Stripe subscription wired, SMS reminders working (if Twilio approved) | Stripe ✅ pulled forward (#73, #74). SMS still blocked on Twilio. |
| 19/5 | Onboarding flow done, first beta salon installed | Onboarding ✅ pulled forward (#76–#79). First beta install pending. |
| 26/5 | Marketing site live, V1 launch 30/5 | Marketing site ❌. Launch on track if beta + external services unblock. |
| 2/6 | First beta salon active, iterate on feedback | — |
| 9/6 | First paying customer (target) | — |
| 16/6 - 30/6 | Push for 3 paying salons total | — |
