# OTP-gate — khôi phục test theo luồng gate-first (NHÓM 28/29)

**Ngày:** 2026-07-16 · **PR:** #764 · **Merge:** `a60ea72` (2026-07-16T13:32:56Z)
**Deploy:** `dpl_4VgNTXVTQe6QVBR4QUPfhtcKXcS2` (production) · **Issue gốc:** #754 (đã đóng)

## Root cause — OTP dời lên gate (có chủ đích)

OTP được chuyển lên **entry gate** (`GateOtpInline` trong `BookingTypeSwitcher.tsx`), commit
`a4042c5` *"gate-first OTP"* + `cfae253` *"move gate OTP inline"*. Với salon `phone_otp_enabled`:

- `flowReady = gateReady && (!phoneOtpEnabled || gateOtpDone)` — service picker + group toggle
  **khoá** cho tới khi OTP verify tại gate.
- Session verify thread vào flow cá nhân (`initialOtpSessionId`) → `useBookingFlowState` **skip**
  step OTP cũ. Panel `#otp-code` (`BookingFlowOtpPanel`) **unreachable** ở luồng cá nhân.

7 test UI booking-otp giả định luồng cũ (OTP **sau** info step) → timeout ở gate. **Không phải
product bug** — test lỗi thời. (Xác nhận bằng git history + trace, điều tra NHÓM 28.)

## Cách sửa (test-side + locator behavior-neutral)

- **Source (chỉ locator):** thêm `data-testid` vào `GateOtpInline` — `booking-gate-otp`,
  `-send`, `-input`, `-verify`, `-resend`, `-error`, `-email-fallback`. **Chỉ attribute JSX**;
  0 thay đổi state/effect/callback/render-condition/validation. **Không đổi OTP business logic.**
- **Helper:** `completeGateOtp(page, {code})` (`e2e/helpers/db.ts`) — click send + nhập demo
  `000000` (6 chữ số auto-verify), ghép sau `completeBookingEntryGate`. Qua UI thật, không
  bypass/mock/`page.evaluate`.

## 6 test đã sửa (giữ nguyên intent bảo mật)

| Test (mới) | Kiểm |
|---|---|
| gate OTP appears before service | OTP hỏi ở gate; service picker **count 0** trước verify (invariant a) |
| wrong code rejected, correct proceeds | code sai → error + flow vẫn khoá; code đúng → mở (invariant b) |
| editing phone after verify re-locks gate | đổi phone reset `gateOtpDone` → re-verify (was "Back from OTP") |
| full booking completes after gate OTP | walk service→...→confirm→booking-success; không OTP lần 2 |
| verified phone not re-texted (anti-double-charge) | 1 lần gate send; điều hướng info↔confirm không re-text |
| email fallback offered at gate OTP | `booking-gate-otp-email-fallback` visible |
| (giữ nguyên) server throttles duplicate SMS | API-level 200 → 429 rate_limited |

## Hai gap product tách ra — nay ĐÃ SỬA (PR #766, merge `7dfe7705`)

> **Cập nhật cuối:** lúc viết (NHÓM 28) hai mục dưới được tách issue + để test đỏ có chủ đích.
> Chúng đã được sửa trong **PR #766** (chế độ tăng tốc, pilot-ready) — ghi lại để chính xác.

- **#261 tel:// call-to-book** — gate OTP từng **thiếu** tel-link A2P (chỉ có ở panel cũ
  unreachable). **ĐÃ SỬA:** `GateOtpInline` render tel:// từ `salon.salonPhone` (i18n có sẵn).
  Test #261 **PASS**. Issue **#762 ĐÓNG**.
- **Group double-OTP** — gate session không thread vào `BookingGroupFlow`. **ĐÃ SỬA:** thread
  `initialOtpSessionId` (mirror flow cá nhân) → group không hỏi OTP lần 2, chỉ 1 SMS gate, không
  double booking. Test `otp-gate` **PASS**. Issue **#763 ĐÓNG**.

## Bảo mật (không đổi)

Không bypass, demo `000000` trơ trong production (`isDemoOtpRuntime` false trừ khi `DEMO_OTP`),
không log code, không lộ trong URL, throttle/rate-limit còn nguyên. `gateOtpDone` chỉ set qua
`handleGateOtpVerified` sau khi verify API trả `ok+sessionId`; submit re-validate server-side.

## Kết quả trước/sau (chromium) — trạng thái CUỐI

- PR #764 (test): non-RC chromium 15→**9 fail** (−6 booking-otp), full chromium **201/182/14/5**.
- PR #766 (2 product fix #762+#763): +2 pass, −2 fail → full chromium **201 / 184 / 12 / 5**.
  **12 fail còn lại = 100% test debt:** landing-funnel 7 (#748) + Receptionist Center chromium 5
  (#749). **0 fail mới.** (Tel-link + otp-gate nay PASS.)
- Required: Smoke ✅ · Build & Type Check ✅ · Security Audit ✅ · Secret scan ✅.
- **NailIQ PILOT READY** cho 3–5 tiệm — xem `PILOT-READINESS-REPORT.md`. Merge cuối `7dfe7705`.
  Production khoẻ, **0 lỗi 500 mới**, không migration, không ghi production.
