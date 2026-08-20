# NailIQ — Project Flowchart

> Last updated: 2026-05-20. Re-derive from codebase if in doubt; this doc is a living map.

---

## ⚡ Refine update (2026-05-20) — Phase 0+1+2

Những thay đổi mới nhất (một số mục bên dưới trong doc cũ đã lỗi thời — ưu tiên phần này):

- **Auth:** Phone OTP đã **retired (2026-05-13)**. Đường chính giờ là Google OAuth + email magic link + email/password, tất cả qua `/auth/callback` → `resolveRoleAndSlugForUser()`. (Doc cũ mô tả phone-OTP/Twilio là sai.)
- **Register seed (P0.3):** `completeSalonRegistrationAction.ts` seed tối đa **10 dịch vụ nail mặc định** (đúng cap Free) + **1 staff "Staff 1" làm-được-tất-cả** (P0.5). Demo path vẫn 1 service.
- **AI Prefill (P2 ⭐):** `/dashboard/[slug]/setup/ai-prefill` — `AIPrefillWizard.tsx` + `aiPrefillServicesAction.ts`. Upload ảnh menu / URL → Claude Vision (`claude-sonnet-4-6`) extract JSON → review → `bulkImportAIServices()`. Là công cụ post-register trong setup.
- **Owner Dashboard 3 empty states (P1.3):** `SalonOwnerDashboard.tsx` (dòng 370–414): State 1 setup chưa xong (checklist) / State 2 setup xong 0 booking (share UI + QR) / State 3 có booking (full).
- **Settings rút gọn (P0.2/P1.1):** NoShow gộp 1 toggle "Tự động nhắc khách" (advanced 24h/3h/SMS collapse). Hours có 3 preset (P0.4). Reviews ẩn cho Free plan (P1.2).
- **Superadmin (P0.1):** `src/shared/superadmin/nav.ts` — 5 mục hiện (Dashboard, Salons, Operations, Support, Settings), ~25 trang ComingSoon ẩn (`mvpHidden:true`, vẫn vào được qua URL).
- **Booking status:** public booking tạo thẳng `status: "confirmed"` (doc cũ ghi pending→confirmed là sai).
- **Stripe:** Subscription (Mô hình A) ĐÃ BUILD — `stripeActions.ts` + webhook. Connect Express (Mô hình B) CHƯA build (Task #12, tháng 6). Stripe-side platform đã setup (Platform · Express · destination charges · risk by Stripe).
- **Cron:** hiện `0 2 * * *` (1 lần/ngày, Hobby plan). Khôi phục 15 phút khi lên Vercel Pro (Task #35).

---

## 0. Top-Level Surface Map

```
                          ┌─────────────────────────────────────────┐
                          │              nailiq.app                  │
                          └──────────────────┬──────────────────────┘
                                             │
              ┌──────────────────────────────┼─────────────────────────────┐
              │                              │                             │
       ┌──────▼──────┐               ┌───────▼──────┐             ┌───────▼──────┐
       │  /[slug]    │               │  /register   │             │ /superadmin  │
       │  Public     │               │  /login      │             │  Platform    │
       │  Booking    │               │  Owner Auth  │             │  Admin       │
       └──────┬──────┘               └───────┬──────┘             └───────┬──────┘
              │                              │                             │
              │                    ┌─────────▼──────────┐                 │
              │                    │ /dashboard/[slug]/  │                 │
              │                    │  center | setup     │                 │
              │                    │  settings | reports │◄────────────────┘
              │                    └─────────────────────┘      (impersonation)
              │
       [No login required]
```

---

## 1. Public Booking Flow — `/[slug]`

```
Guest visits /{salon-slug}
        │
        ▼
resolvePublicBookingPage(slug)
  ├── Salon not found? → 404
  ├── Accepting bookings = false? → "Paused" screen
  └── OK → render BookingPage

        │
        ▼
┌─────────────────────────────────────────────┐
│  STEP 1 — Select Booking Type               │
│  Individual | Group                         │
│  ↓                                          │
│  STEP 2 — Select Service(s)                 │
│  loadServiceCategories()                    │
│  ↓                                          │
│  STEP 3 — Select Staff                      │
│  filterStaffCapableForServices()            │
│  ↓                                          │
│  STEP 4 — Select Date / Time Slot           │
│  getAvailableTimeSlots()                    │
│  assertSlotWithinOpeningHours()             │
│  checkGroupSlotsAvailable() [group only]    │
│  ↓                                          │
│  STEP 5 — Contact Info                      │
│  Name, Phone, Email (optional)             │
│  Honeypot: clientWebsite field              │
└─────────────────────────────────────────────┘
        │
        ▼
 phone_otp_enabled?
  ├── YES → POST /api/booking-otp/send
  │         Guest enters code
  │         POST /api/booking-otp/verify → otpSessionId
  └── NO  → skip

        │
        ▼
submitPublicBooking() [server action]
  ├── Honeypot filled? → fake success (no DB write)
  ├── Phone invalid?   → validation error
  ├── Slot conflict?   → BookingConflictError
  │       (checkBookingConflict via RPC create_public_booking)
  ├── Booking limit exceeded? → error
  └── OK → booking row created (status: pending)
             │
             ▼
          after() → sendConfirmationEmail()
             │
             ▼
          Confirmation screen
          (booking ref, time, staff, services)
```

**DB touched:** `salons`, `services`, `staff`, `staff_service_capabilities`, `bookings`, `closed_dates`, `otps`

---

## 2. Registration Flow — `/register`

```
/register (new owner signup)
        │
        ▼
Phone entry form
sendRegisterOtp(phoneRaw)
  ├── normalizeRegisterPhone()
  └── Returns mode:
      ├── "demo"      → store OTP in `otps`, show modal with code
      ├── "new"       → Twilio Verify SMS
      ├── "returning" → Twilio SMS (will route to dashboard after verify)
      └── "email_link"→ Supabase magic link (future)

        │
        ▼
/register/verify
verifyRegisterOtp(phone, code, rememberDevice)
  ├── Demo mode: validate against `otps` table
  └── Prod mode: validate against Twilio Verify

  Result:
  ├── Returning owner (phone matches salons.phone):
  │     └── Set nailiq-demo-slug cookie
  │         Redirect → /dashboard/[slug]
  ├── Multi-salon owner:
  │     └── Redirect → /choose-salon
  └── New owner:
        └── Create register_completion_tokens row (1h TTL)
            Redirect → /register/setup?token=...

        │
        ▼
/register/setup  (wizard — new owners only)
  ├── Salon name + slug
  │     pickAvailableSalonSlug()
  │     Demo mode → force "demo-salon"
  │     Prod → try slug, add -2/-3 on collision
  ├── Address + timezone
  ├── Opening hours (defaults: 9am–6pm, 6d/wk)
  ├── Services (name, duration, price)
  └── Staff + capabilities

completeSalonRegistrationAction(token, payload)
  ├── Demo: demo-salon exists? → reuse row (skip INSERT)
  └── Prod: INSERT salons, services, staff, staff_service_capabilities
            INSERT salon_members (role: owner)
            DELETE register_completion_tokens
            SET setup_wizard_completed_at

        │
        ▼
/register/success → redirect /dashboard/[slug]/center
```

**DB touched:** `otps`, `register_completion_tokens`, `salons`, `services`, `staff`, `staff_service_capabilities`, `salon_members`, `auth.users`

---

## 3. Login Flow — `/login`

```
/login
  └── Owner already signed in? → redirect /dashboard/[slug]

Phone entry (or email magic link, future)
sendLoginOtp(phoneRaw)
  └── lookupSalonSlugForOwnerPhone()
      ├── Phone not registered? → "Số này chưa đăng ký" error
      └── OK → delegates to sendRegisterOtp() (same backend)

/login/verify
verifyRegisterOtp(phone, code)
  └── finalizeRegisterSessionAfterPhoneOtp(phone)
      ├── Phone matches salon → link salon_members if missing
      │   Redirect → /dashboard/[slug]/center
      ├── Multi-salon → Redirect → /choose-salon
      └── No salon found → create completion_token
          Redirect → /register/setup
```

**DB touched:** `salons`, `salon_members`, `register_completion_tokens`, `auth.users`

---

## 4. Dashboard — Gate & Layout

```
GET /dashboard/[slug]/*
        │
        ▼
layout.tsx
  ├── getDashboardWriteClient(slug) → auth check + membership check
  │     Not authed?  → redirect /login
  │     Not member?  → 403
  └── expireImpersonationIfStale() → clear cookie if >30min
  ├── setup_wizard_completed_at IS NULL? → redirect /register/setup
  └── OK → render dashboard with:
            - Salon data + timezone
            - Queue badge counts (waiting, overdue)
            - Salon switcher (if owner has multiple salons)
```

---

## 4a. Receptionist Center — `/dashboard/[slug]/center`

```
loadReceptionistCenterData()
  ├── Fetch today's bookings (all statuses)
  ├── Group by staff column
  ├── Calculate: overlaps, late flags, overdue count
  └── Render 3-zone layout:
      [Staff Roster | Timeline Grid | Queue]
                           │
        ┌──────────────────┼───────────────────┐
        │                  │                   │
  Staff rows         NOW line            Queue chips
  (fixed left)       scrolls right       (waiting list)

BOOKING BLOCK INTERACTIONS:
Click block → open Drawer
  └── Available actions depend on booking.status:

      pending     → Confirm | Cancel
      confirmed   → Check In | Cancel | Mark No-Show (if overdue)
      arrived     → Seat (→ in_progress) | Move to Queue | Cancel
      waiting     → Seat (→ in_progress) | Cancel
      in_progress → Complete | [late overlay if time exceeded]
      completed   → View only (terminal)
      cancelled   → View only (terminal)
      no_show     → View only (terminal)

RECEPTIONIST ACTIONS (server actions):
  addWalkinToQueue()     → creates booking, status=arrived|waiting
  checkInBooking()       → confirmed → arrived
  seatBooking()          → arrived|waiting → in_progress
  completeBooking()      → in_progress → completed
  cancelBooking()        → any non-terminal → cancelled
  markNoShow()           → confirmed → no_show

All transitions → write audit_logs row
Conflict guard → checkBookingConflict() before every seat/check-in
```

**DB touched:** `bookings`, `staff`, `services`, `salon_members`, `audit_logs`

---

## 4b. Setup Wizard — `/dashboard/[slug]/setup`

```
Checklist page
  ├── /setup/address   → save address + timezone → salons UPDATE
  ├── /setup/hours     → opening hours editor    → salons UPDATE
  ├── /setup/services  → CRUD services           → services INSERT/UPDATE/DELETE
  └── /setup/staff     → CRUD staff + skills     → staff + staff_service_capabilities

All steps optional post-initial setup; checklist marks green when data exists.
```

---

## 4c. Settings — `/dashboard/[slug]/settings`

```
Tabs:
  General       → salon name, timezone, brand_color, theme_mode
  Phone OTP     → toggle phone_otp_enabled (gates booking OTP flow)
  SMS Reminders → toggle sms_reminders_enabled (requires Twilio in platform_settings)
  Modules       → optional feature toggles
  Email         → add/verify owner email → salon_owner_emails
  Billing       → Stripe (if applicable)
```

---

## 5. No-Show Protection Flow

```
AT BOOKING CREATION:
  submitPublicBooking() / addWalkinToQueue()
    └── scoreNoShowRisk(phone, history) → bookings.no_show_risk_score (0–100)
        evaluateDeposit(score) → bookings.deposit_status (null | required | paid)

REMINDER CRON — /api/cron/reminders  [every 15 min, Vercel cron]
  ├── Query bookings: start_time_utc in NOW+24h ±15min  → 24h reminder batch
  ├── Query bookings: start_time_utc in NOW+3h  ±15min  → 3h reminder batch
  └── Per booking:
      ├── reminders_enabled? (salon setting)
      ├── reminder_Xh_sent_at IS NULL? (dedup check)
      ├── client_email → sendReminderEmail() via Resend
      ├── sms_reminders_enabled + client_phone → sendSmsReminder() via Twilio Messages API
      └── UPDATE bookings SET reminder_Xh_sent_at = NOW()

NO-SHOW DETECTION:
  Receptionist sees: confirmed + past start_time → "No-Show?" prompt
  markNoShow() → confirmed → no_show
    └── Triggers waitlist notification:
        booking_waitlist_entries (status: waiting → notified)
        sendWaitlistEmail() / sendWaitlistSms()

WAITLIST FLOW:
  waiting → notified → claimed (if client rebooks) | expired
```

**DB touched:** `bookings`, `booking_reminder_tokens`, `booking_waitlist_entries`

---

## 6. SMS OTP for Public Booking — `/api/booking-otp`

```
(Only active when salons.phone_otp_enabled = true)

POST /api/booking-otp/send
  ├── Generate OTP code
  ├── Store in otps table (10-min TTL)
  ├── Demo mode: return code in response
  └── Prod: send SMS via Twilio

POST /api/booking-otp/verify
  ├── Validate code against otps table
  ├── Delete otps row
  └── Return otpSessionId

submitPublicBooking() validates otpSessionId server-side
  └── Invalid / missing? → booking rejected
```

---

## 7. Superadmin Flows — `/superadmin`

```
/superadmin/login
  └── Email + password → Supabase auth
      getSuperAdminRole(userId) → checks superadmin_roles
      NOT superadmin → 403

SECTIONS:
  /superadmin/.../settings
    └── Platform Settings:
        Twilio: account_sid, auth_token, phone_number → platform_settings
        Resend:  api_key → platform_settings

  /superadmin/.../operations/feature-flags
    └── readAuthPlatformFlags() → toggle SMS/email auth globally

  /superadmin/.../support/audit-logs
    └── loadAuditLogAction() → query audit_logs
        Filters: salon, action, actor, date range

  /superadmin/.../salons
    └── List all salons; drill into per-salon stats + bookings

  /superadmin/.../support/live-access  [IMPERSONATION]
    └── Set cookies:
        nailiq-impersonation-slug
        nailiq-impersonation-token
        (expires 30 min — expireImpersonationIfStale())
        All actions logged: actor = "superadmin_impersonating:{slug}"

  /superadmin/forgot-password
    └── Supabase recovery email → owner resets password
```

**DB touched:** `platform_settings`, `audit_logs`, `salons`, `bookings`, `superadmin_roles`

---

## 8. Booking Status State Machine

```
                          [Public booking / Walk-in]
                                    │
                                    ▼
                               ┌─────────┐
                               │ pending │  (unconfirmed slot)
                               └────┬────┘
                                    │ checkInBooking() or auto-confirm
                                    ▼
                            ┌───────────────┐
                            │  confirmed    │◄──── addWalkinToQueue()
                            └──────┬────────┘       (skip pending)
                     ┌─────────────┼─────────────┐
                     │             │             │
                     ▼             ▼             ▼
               checkIn()      (no arrival     cancel()
                     │         threshold)         │
                     ▼             │             ▼
               ┌─────────┐    markNoShow()  ┌──────────┐
               │ arrived │        │         │cancelled │ ← terminal
               └────┬────┘        ▼         └──────────┘
                    │       ┌──────────┐
            seat()  │       │ no_show  │ ← terminal
                    │       └──────────┘
                    ▼
            ┌─────────────┐
            │ in_progress │
            │  [+ late?]  │  ← overlay flag if duration exceeded
            └──────┬──────┘
                   │ complete()
                   ▼
            ┌───────────┐
            │ completed │ ← terminal
            └───────────┘

Walk-in alternate path:
  addWalkinToQueue() → waiting (no chair available)
    └── seatBooking() → in_progress
```

---

## 9. Three Supabase Clients — When to Use Which

```
src/shared/lib/supabase/
  ├── client.ts     createBrowserClient()   — Client components, Realtime listeners
  ├── server.ts     createServerClient()    — Server components, Server actions (respects RLS)
  └── serviceRole.ts  createClient()        — OTP rows, registration tokens, E2E seeding
                      (SUPABASE_SERVICE_ROLE_KEY — bypasses RLS, server-only)
```

---

## 10. Key Logic Gates (Quick Reference)

| Gate | File | Effect |
|------|------|--------|
| `isDemoOtpRuntime()` | `demoOtpMode.ts` | Skip Twilio; use in-memory OTP; force `demo-salon` slug |
| `salons.phone_otp_enabled` | `submitPublicBooking.ts` | Require OTP proof before booking |
| `salons.accepting_bookings = false` | `resolvePublicBookingPage` | Show "Paused" to guests |
| `setup_wizard_completed_at IS NULL` | `dashboard layout.tsx` | Block dashboard, redirect to setup |
| `salons.sms_reminders_enabled` | cron `/api/cron/reminders` | Gate Twilio SMS send per salon |
| `salon_members.role` | all dashboard actions | owner > senior > nail_tech permission ladder |
| Honeypot `clientWebsite` filled | `submitPublicBooking.ts` | Return fake success, no DB write |
| Conflict check (RPC) | `conflictCheck.ts` | Prevent double-booking same staff + time |
| Impersonation cookie | `expireImpersonationIfStale()` | Auto-expire after 30 min |

---

## 11. External Services

```
Twilio
  ├── Verify service    → register/login OTP SMS
  ├── Messages API      → booking SMS reminders (feat/noshow branch)
  └── Credentials in:   platform_settings (managed by superadmin)

Resend
  ├── Booking confirmation email
  ├── 24h / 3h reminder emails
  ├── Waitlist notification emails
  └── API key in:       platform_settings

Supabase
  ├── Auth (phone OTP + session JWT)
  ├── Postgres + RLS
  └── Realtime (receptionist center live updates)

NailIQ Error Monitor
  ├── Browser:   /api/errors
  ├── Server:    src/instrumentation.ts
  └── Storage:   Supabase error_logs (redacted + deduplicated)

Vercel
  ├── Auto-deploy from main
  └── Cron: /api/cron/reminders every 15 min
```
