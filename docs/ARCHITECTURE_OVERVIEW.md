# NailIQ — Tổng quan kiến trúc

> Tài liệu "đọc 1 lần nắm toàn bộ" cho codebase NailIQ. Dựng từ việc đọc code thật (≈105K LOC, 544 file TS/TSX, 98 migration) ngày 2026-06-01.
> Mục tiêu: người mới (hoặc Claude session mới) đọc xong là biết hệ thống có gì, luồng chạy ra sao, sửa ở đâu, và cái gì đang live / flagged / chưa xong.
>
> ⚠️ **Tài liệu này mô tả hiện trạng, KHÔNG phải hiến pháp.** Hiến pháp UI/UX là `ARCHITECTURE_LOCK.md` + các doc governance. Khi mâu thuẫn, governance docs thắng.

---

## 0. Tóm tắt 1 phút

NailIQ là **SaaS đặt lịch + OS lễ tân đa tenant** cho tiệm nail (thị trường chính: cộng đồng Việt ở US/CA, song ngữ VI/EN). Một codebase Next.js phục vụ **3 surface**:

| Surface | Route | Cho ai | Auth |
|---|---|---|---|
| **Public booking** | `/[slug]` | Khách của tiệm (không cần tài khoản) | Anon + OTP tùy chọn |
| **Dashboard** | `/dashboard/[slug]/*` | Chủ tiệm + lễ tân + thợ | Supabase Auth (OAuth/email/password) |
| **Superadmin** | `/superadmin/*` | NailIQ vận hành (founder/ops…) | Email + password riêng |

Đặt lịch qua **3 kênh**: wizard nhiều bước, **AI chat** (Claude Haiku, chỉ tư vấn), và **voice AI** (OpenAI Realtime qua WebRTC, đặt/hủy/dời lịch bằng giọng nói). Phía vận hành có **Receptionist Center** realtime (lưới timeline + hàng đợi walk-in). Tầng growth: no-show protection, loyalty, gift card, voucher, referral, reviews, website import, và **tích hợp Wix two-way sync** (tenant đầu tiên: Tech Nails).

**Giai đoạn:** hậu mốc V1 (target launch 30/5/2026). North Star = **3 tiệm trả tiền có thẻ trên file trước 30/6/2026**. Rất nhiều tính năng đã code nhưng **ship dark sau feature flag Beta** (mặc định OFF).

---

## 1. Tech stack & quy ước

- **Framework:** Next.js 16.2 (App Router, `proxy.ts` thay cho `middleware.ts`) + React 19.2 + TypeScript 5 strict.
- **DB/Auth/Storage/Realtime:** Supabase (Postgres 17.6, project prod `fshmobzyjhmtvndobwsy`). `@supabase/ssr`.
- **Styling:** Tailwind v4 (CSS-first `@theme` trong `globals.css`, KHÔNG có `tailwind.config.js`). Token mirror ở `src/shared/theme/tokens.ts`.
- **Animation:** Framer Motion 12 + canvas-confetti.
- **Payments:** Stripe (LIVE keys). **Email:** Resend. **SMS/OTP:** Twilio (Verify + Messages). **Error:** Sentry (3 runtime). **AI:** Anthropic (Claude Haiku/Sonnet) + OpenAI (Realtime voice). **Test:** Playwright.
- **Mutation = Server Actions** (`src/shared/{booking,dashboard,register,superadmin,...}`) **+ một số `/api` route** (webhook, cron, voice, OTP, upload — những thứ cần HTTP endpoint thật). CLAUDE.md nói "no REST API routes" — **đã lỗi thời**, hiện có ~40 nhóm route dưới `src/app/api/`.
- **3 Supabase client** (`src/shared/lib/supabase/`): `client.ts` (browser, anon), `server.ts` (SSR, cookie → RLS theo user), `serviceRole.ts` (**bypass RLS, server-only**).
- **Quy ước:** kebab-case file route, PascalCase component, camelCase function; `@/` alias; conventional commits scoped (`feat(booking):`…); 1 PR/logical change, mở **draft** để Huy merge.

---

## 2. Surface 1 — Public booking `/[slug]`

**Mục đích:** trang đặt lịch tự phục vụ của khách. Entry: `src/app/[slug]/page.tsx` (`force-dynamic`). Slug resolve qua `resolvePublicBookingPage.ts` → outcome `reserved`/`redirect(308)`/`not_found`/`ok`.

### 2.1 Happy path (wizard cá nhân)
Các bước: `service → staff → date → time → info → verify → otp → confirm → done` (`useBookingFlowState.ts:53`).

1. `BookingTypeSwitcher` chọn cá nhân/nhóm (nhóm chỉ hiện khi flag `group_booking` ON + đủ capacity) + nút Voice.
2. `BookingFlow` + hook `useBookingFlowState` lái wizard.
3. **time**: fetch slot qua RPC `public_booking_occupancy_for_range` → `computeTimeSlots`; song song gọi `/api/booking/slot-ranking` để gắn nhãn "phổ biến".
4. **info**: validate tên/phone/email client-side + **honeypot** `clientWebsite`; upload ảnh tham chiếu qua `/api/booking/ref-upload`.
5. **verify** (Smart Verification): POST `/api/booking/verify-decision` → RPC `determine_booking_verification` trả `none | otp_optional | otp_required | deposit_required | deposit_or_otp`. **Fail-open** về `none` nếu lỗi.
6. **otp**: `/api/booking-otp/send` (Twilio Verify) → verify → tạo row `phone_otp_sessions` trả `sessionId` làm **capability token**. Demo/E2E nhận code `000000`.
7. **confirm → `submitPublicBooking.ts:139`**: chạy **client-side với anon key**, nhưng trust toàn bộ server-style — revalidate, **chốt giá từ row `services` (không tin giá client)**, check opening-hours + closed-dates, resolve staff (`pickBestStaffAmongFree`), rồi gọi RPC **`create_public_booking`** (SECURITY DEFINER, advisory lock + `tstzrange &&` overlap). Fallback insert cũ đã **bị gỡ + RLS chặn** — chỉ còn 1 đường ghi là RPC.
8. **done**: confetti, tải `.ics`, tra loyalty card, referral share.

Side-effect sau insert (best-effort/fire-and-forget): upsert `client_profiles`, `/api/booking/noshow-evaluate` (AI risk + deposit), `/api/booking-email`, `/api/vouchers/redeem`, **await** `/api/booking/sms-confirm`, set ref image.

### 2.2 AI chat booking — `/api/chat/booking/route.ts`
Claude **`claude-haiku-4-5-20251001`**, streaming, max 256 token. **Không transactional** (không có tool) — chỉ trả lời dịch vụ/giá/giờ và hướng khách về form. Hiện UI chỉ render khi có `ANTHROPIC_API_KEY`. Component: `BookingChatWidget.tsx`.

### 2.3 Voice AI booking — `api/voice/*` + `src/shared/voiceai`
**OpenAI Realtime `gpt-realtime-2` qua WebRTC/WebSocket** (KHÔNG phải Anthropic). Persona mặc định "Lily".
- `/api/voice/session` mint **ephemeral key** (`ek_…`), gate theo `salons.voice_ai_enabled` + cap `voice_ai_sessions_limit`, tạo row `voice_ai_sessions`.
- Client `VoiceBookingModal.tsx` (~1400 dòng) mở WS, stream mic PCM16, có barge-in, auto-renew key ở T−60s.
- `/api/voice/tool` (service-role) chạy 7 tool **transactional thật**: `get_available_slots`, `confirm_booking` (gọi `create_public_booking`, `source='voice'`), `find/cancel/reschedule_booking`, `get_group_available_slots`, `confirm_group_booking` (RPC `insert_group_bookings` + tạo Party Link). Có shim timezone "fake-UTC frame" vì Vercel chạy UTC.

### 2.4 Hotspot
- **Timezone là chỗ dễ vỡ nhất.** 3 "frame" thời gian phải khớp: `create_public_booking` vẫn check giờ mở cửa theo **UTC wall-clock** (TODO dùng `salons.timezone`), voice route tự bù offset, wizard dùng `setHours` local.
- **Conflict được chặn 3 tầng**: pre-check client → advisory lock + `tstzrange` trong RPC → GIST exclusion constraint. DB là chân lý.
- **Deposit collection chưa build**: verification trả `deposit_required` nhưng UI **fallback về OTP** ("until Stripe deposit UI is built", `useBookingFlowState.ts:732`).

---

## 3. Surface 2 — Dashboard `/dashboard/[slug]/*`

**Mục đích:** buồng lái vận hành cho chủ + lễ tân + thợ. Role lấy từ `salon_members.role` (`owner | senior | nail_tech`); gate **per-page server-side** + lặp lại **trong từng server action** (defense-in-depth). Helper: `src/shared/lib/salonMemberRole.ts` (`canEditBooking`/`canCancelBooking`: owner+senior; nail_tech read-mostly).

### 3.1 App shell — `src/app/dashboard/[slug]/layout.tsx`
Mỗi request: (1) `expireImpersonationIfStale()` (cửa sổ impersonation 30 phút), (2) resolve membership 1 lần qua `getDashboardWriteClient(slug)`, (3) **force-wizard gate**: nếu `salons.setup_wizard_completed_at IS NULL` → `redirect("/register/setup")`, (4) prefetch badge counts + resolve Beta flag server-side, (5) render `ImpersonationBanner` + `DashboardShell`.

`DashboardShell.tsx` + `DashboardSidebar.tsx`: sidebar trái (md+) / bottom nav (mobile), 4 nhóm (live/data/insight/config), mỗi item có `hidden: featureOff(<key>)`. **Basic Mode** thu gọn còn {front-desk, queue, calendar, clients, settings}.

### 3.2 Receptionist Center — `center/page.tsx` + `ReceptionistCenter.tsx` (~2600 dòng)
Lưới timeline + hàng đợi walk-in realtime. **3-zone layout** (trái=staff, giữa=timeline, phải=queue) — locked bởi `DASHBOARD_LAYOUT_RULES.md`.

- **Realtime:** có session → Supabase Realtime channel `postgres_changes` trên `bookings` (filter `salon_id`); không session (demo cookie) → **polling 8s**. Mỗi mutation gọi `reloadCurrentDay()` + `router.refresh()`.
- **Vòng đời walk-in** (`waiting → confirmed → in_progress → completed`, qua `receptionistActions.ts`): add (`addWalkinToQueue`), add+assign (`addWalkinAndAssign`, gate `walkin_auto_assign`), assign slot (`assignWalkinToSlot`, atomic guard `.eq('status','waiting')` + xử lý `23P01` GIST), start/complete (`updateBookingStatus`), soft-hold ("bước ra ngoài"), cancel (undo toast 5–8s).
- **Drawer + edit:** `BookingDetailDrawer` (leaf "ngu", model precompute ở parent, mask phone). Edit qua `EditBookingForm → editBookingAction → performEditBooking` (`editBookingCore.ts`). Booking gốc **Wix pending** có nút **Duyệt/Từ chối** (`approveWixBooking`/`declineWixBooking`, write-back về Wix).
- Khác: TV Mode, rush-hour mode, sound alerts, view Day/Week/Month (deep-link `?view=`).

### 3.3 Các trang owner (1 dòng/trang)
| Route | Làm gì | Gate |
|---|---|---|
| `/` | Home: bookings hôm nay, stats, setup checklist, share URL/QR, loyalty + notif widget | member |
| `/reports` | Doanh thu/booking analytics; staff-performance = Studio plan | **owner + Beta `advanced_reports`** |
| `/clients` | Profile khách (VIP, preferred staff, lịch sử) — `client_profiles` global theo phone | owner+senior |
| `/settings` | Hub config: modules/preset, brand color, theme, walk-in auto-assign, queue mode, phone-OTP, reminders, verification mode, Google review URL, voice persona | member (write owner-only) |
| `/settings/my-page` | CMS trang booking công khai (`salon_page_sections`, RPC `seed_default_page_sections`) | owner |
| `/setup/{services,staff,hours,address,loyalty,voice,ai-prefill}` | Catalog & onboarding; `ai-prefill` = AI seed dịch vụ | loyalty/voice = Beta flag |
| `/combos` | Bundle dịch vụ giảm giá (`service_combos`) | **Beta `combos`** |
| `/photos` | Ảnh sau dịch vụ + AI quality score, signed URL Storage | owner+senior + **Pro** |
| `/referrals` | Mã giới thiệu + stats | **owner + Studio `bring_a_friend`** |
| `/reviews` | List review + avg sao | **owner + Pro** |
| `/no-show-protection` | Reminders, unconfirmed, waitlist, deposit threshold | **ẩn khỏi sidebar** (URL-only) |
| `/qr-poster` | Poster QR in được | member |
| `/import` | Dán URL web cũ → scrape dịch vụ/ảnh (`website_import_jobs`, 1/24h) | member |

### 3.4 Server actions chính (`src/shared/dashboard/`)
Tất cả qua **`getDashboardWriteClient(slug)`** → `resolveSalonForDashboard` (member path qua `salon_members`, hoặc demo-cookie path service-role pin `DEMO_SALON_SLUG`). Trả `{salon, role, supabase}`.
- `loadReceptionistCenterData.ts` — read lớn (salon + staff + services + queue priority-sorted + bookings + KPI).
- `receptionistActions.ts` — mutation walk-in/cancel/approve-wix/edit (mỗi cái re-check `salon.id` + role + atomic guard + audit).
- `salonOwnerActions.ts` — `updateBookingStatus` (bảng transition `:463`), settings writers (đa số owner-only), `loadOwnerSalons`, `signOutAction`.
- `setupActions.ts` — CRUD catalog/onboarding (plan-limit gate, soft-delete, auto-attach `staff_services`, AI auto-description Haiku).

### 3.5 Hotspot
- Conflict-on-edit/assign cũng **3 tầng** như public.
- `late` là **overlay** (`in_progress && end<now`), không phải status.
- Nhiều `as never` cast trên cột `salons` (column có thật qua migration nhưng chưa regenerate vào types) — dễ vỡ nếu schema/types lệch.
- `has_design` là **heuristic regex** trên tên dịch vụ, không phải cột thật.
- Demo-cookie + service-role là attack surface, chặn bằng slug pin; `NAILIQ_TEST_BYPASS_SLUG_PIN=1` **không được set trên prod**.

---

## 4. Surface 3 — Superadmin `/superadmin/*`

**Mục đích:** console vận hành nội bộ NailIQ. Auth **email+password riêng** (`loginSuperadmin`), không có đăng ký công khai (seed row `superadmins` qua service-role). Role platform: `founder | ops_admin | support_admin | billing_admin | ai_admin | readonly_analyst`.

- **Shell** `(shell)/layout.tsx`: gate 1 lần — không user → `/superadmin/login`; không phải superadmin → **`notFound()`** (không lộ shell). Nav single-source `src/shared/superadmin/nav.ts`; item chưa tới hiện **disabled** (không ẩn), `mvpHidden` thì bỏ khỏi sidebar.
- **Salon list/detail** (read-only) + các card mutation: `ImpersonateButton`, `SalonOverrideCard`, `SalonReleaseFeaturesCard`, `DeletedRecordsSection`.
- **Impersonation (THẬT, founder-only):** `startImpersonation` validate reason → resolve owner của salon → **ghi audit `impersonate_enter` TRƯỚC khi swap** (abort nếu audit fail) → stash token founder (`nq-imp-original`) → mint session owner thật qua `admin.generateLink` + `verifyOtp` → redirect dashboard. Exit/expire ghi audit `impersonate_exit/expire`. Banner sticky đếm ngược 30 phút. Token **chưa mã hóa** (V1, deferred post-SOC2).
- **Feature flags admin, announcements, audit logs, platform settings** (Twilio/Resend keys + test-connection, secret masked) — đều THẬT, audit-or-rollback.
- **Placeholder (`ComingSoonPage`):** toàn bộ `ai/*`, `analytics/*`, `billing/*`, `security/*`, và operations/{incidents,system-health,maintenance,rollouts}, support/live-access.

---

## 5. Auth & RBAC (xuyên surface)

**Hai trục auth độc lập** (PERMISSION_MATRIX §8): salon-facing vs superadmin.

- **Salon login:** Google OAuth + email magic link + email/password là đường LIVE (`/register`). **Phone OTP đã retire trên prod 2026-05-13** (Twilio chưa duyệt) — code còn nguyên nhưng `isPhoneOtpDisabledInProd()` chặn, chỉ chạy dev/E2E.
- **`proxy.ts`** (Next 16, đừng đổi tên thành `middleware.ts`): rate-limit (booking/auth) → refresh session (`getUser` + copy cookie sang redirect response) → Sentry tags → demo cookie → **route gate** (chưa auth `/dashboard/*` → `/register`; `/superadmin/*` → `/superadmin/login`). **Proxy chỉ bounce chưa-auth; role/membership check thật nằm ở server component + action.**
- **Onboarding:** `/register` → (OAuth/email) `/auth/callback` → user chưa có membership → `/register/setup` → `completeSalonRegistration` tạo salon + 12 dịch vụ mặc định + 1 staff + `salon_members(owner)` + stamp `setup_wizard_completed_at`. Có **dual path**: sessionStorage (`registerSessionKeys.ts`) + server-side fallback (`register_completion_tokens` table, TTL 1h, `loadRegisterFlowState`). Completion token nay thread qua URL `?ct=`.
- **RBAC:** owner = full config; senior = full desk ops, không config salon-wide; nail_tech = read-mostly. `normalizeSalonMemberRole` default NULL → **owner** (most-permissive). Superadmin role resolve qua `getSuperAdminRole(userId)` (service-role, cache 5 phút, fail-safe → không phải superadmin).

### Gotcha auth
- **`notFound()` trả HTTP 200** ở `/dashboard/[slug]/*`, `/v/[token]`, `/party/[token]` (force-dynamic stream) — bảo mật đúng (không serve content) nhưng **E2E phải assert theo nội dung render, không theo status code**.
- **Superadmin E2E login race**: `loginAsSuperadmin` + `page.goto` ngay flake trên project **mobile** (redirect 2-hop). Chạy spec superadmin trên **cả 2 project** trước merge. (Salon login đã fix bằng `window.location.assign`; superadmin dùng `router.replace`.)
- Comment "not yet in auto-generated types" ở nhiều file đã **stale** — types đã regenerate.

---

## 6. Tầng dữ liệu — Supabase

> ⚠️ **`src/lib/database.types.ts` + DB live là chân lý, KHÔNG phải thư mục migration.** Core table (`salons/services/staff/bookings`) và nhiều feature table + toàn bộ pg_cron job được tạo qua dashboard/`db push`, **không có file `CREATE TABLE`** trên đĩa.

### 6.1 Bảng cốt lõi
- **`salons`** (51 cột) — root tenant: slug/name/phone/timezone/opening_hours(jsonb)/booking_closed_dates(jsonb)/currency_code/brand_color/theme_mode; billing (`subscription_plan/status`, `stripe_*`, `plan_override` CHECK `free|pro|premium`); superadmin (`feature_flags` jsonb, `is_beta`, `admin_notes`, `archived_at`); verification (`booking_verification_mode`, `verification_risk_threshold_*`, `deposit_*`, `phone_otp_enabled`); voice (`voice_ai_*`); dashboard prefs.
- **`salon_members`** — junction (salon_id, user_id) unique + `role`. **RLS anchor** của hầu hết policy.
- **`services`** / **`staff`** / **`staff_services`** (capability whitelist; 0 row = "ai cũng làm được"; có row đầu → authoritative).
- **`bookings`** (49 cột) — trung tâm. **3 enum CHECK quan trọng (chính xác):**
  - `status`: `pending | confirmed | completed | cancelled | waiting | in_progress`
  - `source`: `appointment | walkin | voice`
  - `verification_method`: NULL | `none | otp | deposit | both | vip_skip`
  - + `deposit_status`, `walkin_priority/source`, `party_size(1-50)`, `no_show_risk_score(0-100)`, `group_id/group_size/wave_number`, `wix_booking_id`, `soft_hold_until`, `idempotency_key`(UUID)…
- **`client_profiles`** — global theo phone (VIP/visit/no_show/preferred_staff). **GLOBAL cross-salon by design.**
- **`otps`** / **`register_completion_tokens`** / **`phone_otp_sessions`** (TTL 15 phút, capability token) / **`email_verification_tokens`** — đều RLS deny-all (service-role).

### 6.2 Bảng theo feature (1 dòng)
no-show/deposit/verification = cột trên salons+bookings + `booking_reminder_tokens` · loyalty = `loyalty_programs`/`loyalty_cards`/`loyalty_stamp_events` · gift/voucher = `vouchers`/`voucher_redemptions` · group = `party_links`/`party_link_claims`/`party_link_change_requests` + `bookings.group_id/wave_number` · notif = `booking_notifications` (twilio_message_sid unique, **trong Realtime publication**) · audit = `booking_events` (append-only, service-role) · `booking_waitlist_entries` · `reviews` (request_token) · `referrals` · `booking_photos`/`customer_photo_consents` · `website_import_jobs` · `wix_integrations` (PK salon_id, service-role) · `service_combos` · `salon_page_sections` · `voice_ai_sessions`/`ai_chats`/`ai_trend_cache`/`ai_upsell_log` · `customer_preferences`/`customer_booking_patterns`.

### 6.3 RPC chính (SECURITY DEFINER, search_path pinned)
- **`create_public_booking`** — hàm nhiều version nhất (v2.2/v2.3/v2.4): validate giờ mở cửa (theo TZ salon ở bản mới), closed-dates, conflict, **snapshot giá**, advisory lock; trả `{success, booking_id}` hoặc `{success:false, code}`.
- `public_booking_occupancy_for_range` (anon occupancy) · `salon_slug_similarity` · `insert_group_bookings` (atomic + wave) · `check_group_slots_available` · `determine_booking_verification` (v2) + `compute_no_show_risk` (IMMUTABLE 0-100) + `confirm_booking_with_otp` · `claim_party_slot`/`update_party_claim_details` · `reschedule/cancel/confirm_booking_as_customer` (token-gated) · `create_referral_code` · `get_salon_queue`/`add_queue_entry`/`update_queue_entry_status` · `salon_has_staff_services` · `increment_voice_session_if_under_limit` · `seed_default_page_sections` · trigger `auto_stamp_on_booking_complete`.

### 6.4 RLS / cron / constraint
- **RLS:** mọi bảng bật RLS. Predicate canonical: `salon_id IN (SELECT salon_id FROM salon_members WHERE user_id = auth.uid())`. Anon đọc catalog (`using(true)`), insert booking gated "salon tồn tại + chưa archive", **không** SELECT/UPDATE bookings. Service-role bypass cho OTP/token/settings/events/notif/superadmin/Wix/party-create.
- **pg_cron (6 job, CHỈ ở dashboard, KHÔNG trong migration):** birthday-voucher (9h), welcome-back (T2 10h), trend-refresh (3h), pattern-detector (2h), auto-reconfirm (8h), và **#6 `release-unverified-pending-bookings`** (`*/5`, **inline SQL**): cancel `pending` + `verification_method IS NULL` + `created_at < now-15min`.
- **Vercel cron (`vercel.json`, 2 job):** `/api/cron/reminders` (daily 2h) + `/api/cron/wix-sync` (`*/2`). ⚠️ Route `/api/cron/release-pending` **tồn tại nhưng KHÔNG đăng ký** trong vercel.json — logic release-pending chạy qua **pg_cron #6** chứ không qua route này.
- **11 Edge Function:** cron-auto-reconfirm, cron-birthday-voucher, cron-trend-refresh, cron-welcome-back, pattern-detector, photo-enhance, photo-send-sms, photo-upload, referral-claim, referral-complete, scrape-website.
- **Constraint đáng nhớ:** GIST `bookings_no_overlap` EXCLUDE (salon, staff, tstzrange) WHERE status≠cancelled (cần `btree_gist`) · partial unique `wix_booking_id WHERE NOT NULL` · name-safety CHECK (`!~ '[<>{}=&;]'`, len 1-100) · soft-delete `deleted_at` (lưu ý: unique `phone`/`slug` vẫn bị row đã xóa-mềm giữ chỗ).

### 6.5 Migration drift (đã biết)
98 file trên đĩa vs 93 row tracked trên prod. `db push` re-stamp timestamp → `supabase migration list` lệch id tràn lan. Prod có migration **không có file local** (vd `add_voice_ai_columns_and_sessions_table`). Có file **trùng timestamp** (`20260430180000`, `20260430240000`, `20260524230000`). `docs/migration-fix-plan.md` (2026-05-04) là runbook cũ; drift vẫn còn + đã lớn hơn. **Để deploy lặp lại được trước scale, cần reconcile** (capture cron + table tạo-ngoài-luồng vào file).

---

## 7. Tích hợp & tính năng growth

| # | Feature | Làm gì | Dịch vụ / env | Trạng thái |
|---|---|---|---|---|
| 1 | **Wix two-way sync** | Forward cron 2 phút (Wix→NailIQ) + write-back confirm/cancel/decline. Tenant: Tech Nails. | `WIX_API_KEY` (raw `Authorization` header, strip whitespace) | **PROD** (key thật, cron đăng ký, tenant seeded). Write-back cần Wix Manage scope. |
| 2 | **Stripe** | Sub Pro/Premium qua Checkout + Portal; `PLAN_LIMITS`; webhook map price→plan. `plan_override` short-circuit. | `STRIPE_SECRET_KEY` (**LIVE**), `STRIPE_PRICE_*`, `whsec_` | **PROD** (full checkout↔webhook↔portal). Demo tenant dùng `plan_override='premium'`. |
| 3 | **Resend email** | Confirm, reminder, email-verify, review request, waitlist claim, contact, import-done. Dùng `after()` để outlive action. | `RESEND_API_KEY` (rỗng local → no-op) | **Wired**, gated cred trên prod. |
| 4 | **Twilio SMS** | 2 surface: Verify (OTP) + Messages (reminder/confirm/review). Creds từ `platform_settings` → env fallback. Delivery receipt HMAC `/api/twilio/status`. | `TWILIO_*` (rỗng local) | **Wired**, dormant tới khi có cred. |
| 5 | **No-show protection** | `evaluateDeposit` (pure rules) + **`scoreNoShowRisk` dùng Claude Haiku** (fallback deterministic) → ghi `no_show_risk_score`. Reminder + waitlist auto-fill (`SKIP LOCKED`) + reschedule. ⚠️ 2 số risk khác nhau: RPC `compute_no_show_risk` (gate verify) vs Haiku score (hiển thị). | `ANTHROPIC_API_KEY` | **PROD** cho rules/risk/reminder. **Deposit collection CHƯA build.** |
| 6 | **Loyalty** | Stamp card → reward. Gate **kép**: release flag `loyalty` (Beta OFF) **+** plan premium. | — | **Flagged Beta + Premium-only.** |
| 7 | **Reviews** | Auto request khi booking `completed`; email có nút **Google 5 sao** (`salons.google_review_url`) + fallback rating NailIQ token-based. | Resend/Twilio | **Flagged Beta + Pro+.** |
| 8 | **Referrals** | Mã giới thiệu, referee giảm giá, cả hai nhận voucher khi referee complete (edge fn). Share URL hardcode host `nailiq.ca`. Track-share = `console.log` stub. | edge fn + Twilio | **Wired** (`bring_a_friend`). |
| 9 | **Gift card / voucher** | Voucher validate/redeem **server-trust** (không tin client). Gift card = voucher `kind:gift`. | Stripe column tồn tại **nhưng unused** | Voucher **solid**; gift purchase **KHÔNG thu tiền** (WIP). |
| 10 | **Trends & upsell** | Trends = top style từ `booking_photos` (premium, edge fn `cron-trend-refresh`). Upsell = analytics tần suất (KHÔNG phải LLM dù tên `ai_`). | — | Trends premium + cần edge schedule (chưa thấy trong repo config). Upsell Pro+ live. |
| 11 | **Website import** | Dán URL → scrape → **Claude Sonnet 4.6 extract** JSON (name/services≤15/brand/images) → upsert salon. Rate-limit 1/24h. | `ANTHROPIC_API_KEY` (edge fn `scrape-website`) | **PROD-shaped**, live nơi edge fn deploy + key set. |
| 12 | **Party/group link** | Sau group booking → link `/party/<token>` chia sẻ; member claim slot (RPC `claim_party_slot` race-proof); đổi/đổi-yêu-cầu. **Phone không bao giờ lộ cho anon.** Hỗ trợ wave. | — | **Flagged Beta `group_booking`.** |

**Đánh giá live thật:** trụ cứng đã live = **Wix sync + Stripe billing**. Live-nhưng-gated-cred = Resend/Twilio/Haiku risk/Sonnet import. Built-dark sau Beta flag (OFF) = group/party, loyalty, reviews, photos, marketing, combos, advanced reports. **Gap lớn nhất = đường THU TIỀN giữa booking**: deposit (flag `deposit_required` nhưng fallback OTP) + gift card (mint giá trị, không charge).

---

## 8. Cross-cutting

### 8.1 Hai hệ thống gating (ĐỪNG nhầm) + ba "feature flag"
1. **Release feature flags** (Base vs Beta) — `src/shared/features/featureRegistry.ts`. 10 key Base (default ON) + 10 Beta (default OFF). Resolver `isReleaseFeatureEnabled(salon, key)`. Override per-salon đọc từ: `salons.feature_flags` jsonb (5 key) / cột `voice_ai_enabled` / plan. **Không có bảng riêng cho release flag.** Gate route bằng inline resolve + `notFound()` hoặc helper `requireReleaseFeatureEnabled(slug, key)`. Editor: superadmin `SalonReleaseFeaturesCard` (chỉ sửa được 5 key jsonb).
2. **Plan tiers (billing)** — `src/lib/feature-gating.ts` (`hasFeature` + `PLAN_FEATURES`) + `src/shared/lib/subscriptionPlans.ts`. Câu hỏi khác: "tier này có được dùng không". Một feature có thể Base-stable **mà vẫn** plan-gated (reviews/photos).
3. **Bảng table-level (đừng nhầm với #1):** `platform_flags` (global switch: `demo_otp_enabled`, `stripe_billing_enabled`, `sms_enabled`, `email_enabled`, `new_salon_registration`) **và** `platform_feature_flags` (superadmin foundation) — **hai bảng khác nhau, cùng tồn tại**. Release gating (#1) KHÔNG dùng bảng nào trong số này.

> **Gotcha:** `notFound()` ở dashboard/party/v routes trả **HTTP 200** → E2E assert theo content (heading "Page not found" hiện + content bị ẩn), không theo status. Xem `e2e/feature-flags/route-gating.spec.ts`.

### 8.2 i18n — hai scope ngôn ngữ độc lập
- **Public booking:** cookie `nq-booking-lang`, **default VI**. Server resolver `resolveBookingLanguage()` (cookie → Accept-Language → VI). Force-dynamic nên đổi cookie là re-render.
- **Dashboard + landing:** localStorage `nailiq-user-lang` **mirror sang cookie cùng tên** (tránh hydration flash), **default EN**. Client `UserLanguageProvider` mount ở root layout; `getUserMessages(lang)` → `userEn/userVi`.
- ⚠️ **KHÔNG** có split file `i18n.ts`/`i18n-server.ts` như project khác của Huy — ở đây là pattern **server-resolver + client-context** dưới `src/shared/i18n/{booking,user}/`. Cột song ngữ dùng suffix **`_vi`** (vd `service_categories.name_en/name_vi`), **không** phải `*Vn`.

### 8.3 SEO
`src/shared/seo/`: `getSiteUrl()` (default `www.nailiq.ca`), `jsonLd.ts` (Organization + WebSite + SoftwareApplication cho landing; NailSalon LocalBusiness + ReserveAction cho salon). `robots.ts` (chặn dashboard/api/login/superadmin). `sitemap.ts` (force-dynamic, static + per-salon từ Supabase, loại slug `e2e-%`). `public/llms.txt` cho AI crawler.

### 8.4 Design system constitution
`src/components/ui/` = 14 file (Badge, BookingCard, Button, Card, Drawer, Input, KPIWidget, Modal, QueueChip, SaveButton, Section, StaffAvatar, Toast, Toggle) + `icons/`. **10 primitive "locked"** có contract trong `COMPONENT_RULES.md` §2: Button, Card, Modal, Drawer, Badge, Toggle, KPIWidget, QueueChip, BookingCard, StaffAvatar.
- **`ARCHITECTURE_LOCK.md`** = hiến pháp ràng buộc, 10 luật bất khả xâm phạm (reuse UI, không màu/spacing/animation ngoài token, không bypass state-machine/permission-matrix, không di chuyển 3-zone layout, không stack modal, không tăng tải nhận thức lễ tân). Thứ tự giải quyết xung đột: LOCK > governance > convention > prompt > judgment.
- DESIGN_SYSTEM (4px base, scale space/type/radius/shadow/z-index) · COLOR_TOKENS (dark-first, gold `#D4AF37` chỉ CTA/VIP, "không bao giờ chỉ dùng hue") · ANIMATION_RULES (Framer only, trần 500ms) · DASHBOARD_LAYOUT_RULES (3-zone) · UX_PRINCIPLES (11 golden rule, operational-first) · MENTAL_MODEL (mỗi role đọc dashboard ra sao).

### 8.5 Config / no-hardcode
`src/shared/config/constants.ts` chỉ chứa tunable toàn-app (không per-tenant). Branding per-salon **đọc từ row `salons`** (name/description/address/phone/brand_color/currency/timezone/opening_hours) → thread vào CSS custom property + JSON-LD ở `src/app/[slug]/page.tsx:147`. Đổi brand/contact/giờ **không cần sửa code**.

### 8.6 Observability
Sentry 3 runtime: `sentry.client.config.ts` (root, sample prod 0.2), `src/sentry.server.config.ts` (0.25), `src/sentry.edge.config.ts` (0.2). Server/edge có `tracePropagationTargets` loại `api.openai.com` (header trace làm hỏng `/v1/realtime`). `src/instrumentation.ts` dispatch theo `NEXT_RUNTIME`. `setPublicBookingSalonTags` tag lỗi theo tenant. `/api/health` = liveness thuần (không DB).

---

## 9. Bản đồ "muốn sửa X → đọc file Y"

| Muốn động vào | Đọc trước |
|---|---|
| Luồng đặt lịch công khai | `src/lib/booking/useBookingFlowState.ts`, `src/shared/booking/submitPublicBooking.ts`, RPC `create_public_booking` (migration `20260430250000`) |
| Conflict / double-booking | `src/shared/lib/conflictCheck.ts` (⚠️ KHÔNG ở `shared/booking`), GIST `bookings_no_overlap`, advisory lock trong RPC |
| Giờ mở cửa / timezone | `src/shared/lib/salonTime.ts`, `salons.timezone`/`opening_hours`, 3 frame TZ ở §2.4 |
| Receptionist board | `src/components/receptionist/ReceptionistCenter.tsx`, `src/shared/dashboard/loadReceptionistCenterData.ts`, `receptionistActions.ts` |
| Trạng thái booking | `docs/STATE_MACHINE.md`, `updateBookingStatus` (`salonOwnerActions.ts:432`, bảng `:463`) |
| Auth / membership gate | `src/shared/dashboard/setupActions.ts` (`getDashboardWriteClient`), `src/shared/lib/salonMemberRole.ts`, `docs/PERMISSION_MATRIX.md` |
| Onboarding/đăng ký | `src/shared/register/`, `completeSalonRegistrationAction.ts`, force-wizard gate ở `dashboard/[slug]/layout.tsx:63` |
| Feature flag (Base/Beta) | `src/shared/features/featureRegistry.ts`, `docs/FEATURE_FLAGS.md` |
| Plan/billing | `src/lib/feature-gating.ts`, `src/shared/lib/subscriptionPlans.ts`, `api/stripe/webhook` |
| Wix sync | `src/shared/integrations/wix/`, `api/cron/wix-sync`, migration `20260601000000` |
| Voice AI | `src/shared/voiceai/`, `api/voice/{session,sdp,tool}`, `VoiceBookingModal.tsx` |
| Schema thật | `src/lib/database.types.ts` + DB live (KHÔNG phải thư mục migration) |
| UI primitive / màu / animation | `docs/ARCHITECTURE_LOCK.md` → `COMPONENT_RULES.md`/`COLOR_TOKENS.md`/`ANIMATION_RULES.md`, `src/components/ui/` |

---

## 10. Điểm cần lưu ý khi sửa (tổng hợp gotcha)

1. **Schema thật = `database.types.ts` + DB live**, không phải migration dir (drift lớn, core table không có create-migration).
2. **Scheduler chia 3 chỗ**: pg_cron (6 job, dashboard-only) + Vercel cron (2 job) + 11 Edge Function. `release-pending` chạy qua pg_cron #6, KHÔNG qua route Next.js.
3. **Timezone** là nguồn bug tinh vi nhất (3 frame phải khớp).
4. **Deposit & gift card chưa thu tiền** — đừng tưởng đã có payment.
5. **`notFound()` trả 200** ở route force-dynamic → assert E2E theo content.
6. **Superadmin E2E flake trên mobile project** → chạy cả 2 project trước merge.
7. **Conflict 3 tầng**, DB (GIST + advisory lock) là chân lý.
8. **Branch từ `origin/main`** (worktree giữ `main`); **E2E đỏ trên main là đã biết** — gate thật là Build/Type-Check/i18n/Security.
9. **`NAILIQ_TEST_BYPASS_SLUG_PIN=1` tuyệt đối không set trên prod.**
10. **Comment "not in generated types" đã stale** — types đã regenerate; vẫn còn nhiều `as never` cast.

---

*Tài liệu sinh ngày 2026-06-01 bằng cách đọc code thật qua 6 sub-agent (public booking, dashboard, auth/superadmin, data layer, integrations, cross-cutting). Khi đọc lại sau này, verify file:line với code hiện tại trước khi coi là sự thật — codebase đang phát triển rất nhanh.*
