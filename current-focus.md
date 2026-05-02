# Current Focus
> Last updated: 2026-05-02
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
- [ ] Apply Stripe account, submit business docs
- [ ] Twilio A2P 10DLC brand registration + campaign setup
- [ ] Domain verification cho transactional email (Resend/Postmark)

Estimate: 3-4h tuần này (chủ yếu form filling, đợi async).

---

### Task 2: Walk-in queue MVP end-to-end
**Why critical**: H3 differentiator trong product.md. Nếu V1 chỉ có appointment booking như Booksy → no moat.

Sub-tasks:
- [ ] Add walk-in customer to queue (no appointment needed)
- [ ] Assign / request specific technician
- [ ] Estimated wait time calculation
- [ ] Notify when ready (display first, SMS sau khi Twilio approved)

Estimate: 3-4 ngày code.

---

### Task 3: Beta user pipeline outreach
**Why critical**: Non-coding work mà solo dev hay skip. Nếu launch 30/5 mà chưa biết 5 salon nào sẽ install → wasted 4 tuần.

Sub-tasks:
- [ ] Build list 20 Vietnamese salon owner US/Canada (FB groups, Yelp, Zalo network)
- [ ] Tạo 1-pager pitch + beta access offer
- [ ] DM 10 trong 20 → goal 5 confirmed beta interest

Estimate: 2-3h spread trong tuần. Conversion typical 10-20%, nên 20 DMs → ~3-5 yes.

## In progress (carried over)

### MVP build status
- Stack: Next.js 16.2.4, TypeScript clean
- ✅ Dashboard core
- ✅ i18n setup (Vietnamese + English)
- ✅ Booking domain models (`dashboardBookingMap.ts`, `bookingIdsEqual.ts`)
- ✅ Health check passed 2026-05-02 (typecheck + build + e2e 16/16 + manual smoke test public booking + dashboard)
- ❌ Walk-in queue (Task 2 tuần này)
- ❌ Stripe subscription integration (sau khi account verified)
- ❌ SMS reminders (sau khi Twilio approved)
- ❌ Onboarding flow (week 3)
- ❌ Public marketing site (week 4)

### Active investigation
None.

## Recently shipped
[Pre-launch — chưa public ship. Update khi có release.]

## Parking lot (DO NOT BUILD V1)
> Reference từ product.md. Activate triggers ghi rõ.

| Item | Trigger to revisit |
|------|---------------------|
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

### P3 (lint debt — defer post-launch)
Tổng 18 ESLint errors, 0 functional impact. Build pass, typecheck pass, e2e 16/16 pass. Xem decision 2026-05-02 trong decisions-log.md.

- 12 lỗi `react-hooks/set-state-in-effect` (React 19 rule): `BookingFlowDatePanel`, `BookingReturningGreeting`, `useBookingFlowState` (5 chỗ), `SalonOwnerDashboard`, `Toast`, `HomeLanding`
- 2 lỗi `react-hooks/refs` (access ref during render): `SetupDeleteConfirm`, `Toast`
- 1 lỗi `react-hooks/preserve-manual-memoization`: `BookingFlowDonePanel`
- 1 lỗi `react/no-unescaped-entities`: `SalonBookingNotFound` (trivial)
- 3 lỗi require() imports trong `scripts/auto-push.js` (dev script, không production)

## Decisions cần làm tuần này
- [x] Free trial length: 7 ngày hay 14 ngày? → **14 ngày** (decision 2026-05-02)
- [ ] Stripe pricing tiers exact: chỉ $29 monthly, hay có annual ($290/year = 2 months free)?
- [ ] Beta pricing: free 1 tháng, hay $9 founding member rate, hay full $29?

## External blockers
- Stripe account approval (1-2 ngày sau submit)
- Twilio A2P 10DLC approval (1-3 tuần sau registration)
- Resend/Postmark domain verification (vài giờ)

## Capacity check tuần này
- **Capacity**: Full
- **Focus split**: 70% code (Task 2) / 20% admin (Task 1) / 10% outreach (Task 3)
- **Avoid tuần này**: middleware migration, polish UI, dark mode, mobile optimization
- **Risk**: scope creep từ "I'll just clean up X while I'm in this file" — REJECT

## Quarter milestones (Q2 2026)

| Week of | Milestone |
|---------|-----------|
| 5/5 | External services setup, walk-in queue done, 5 beta interest confirmed |
| 12/5 | Stripe subscription wired, SMS reminders working (if Twilio approved) |
| 19/5 | Onboarding flow done, first beta salon installed |
| 26/5 | Marketing site live, V1 launch 30/5 |
| 2/6 | First beta salon active, iterate on feedback |
| 9/6 | First paying customer (target) |
| 16/6 - 30/6 | Push for 3 paying salons total |
