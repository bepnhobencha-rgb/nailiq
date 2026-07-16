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

## Giữ ĐỎ có chủ đích + tách issue

- **#261 tel:// call-to-book** — gate OTP **thiếu** tel-link A2P (chỉ có ở panel cũ
  unreachable). Test **giữ đỏ** để document gap; **KHÔNG** hạ assertion, **KHÔNG** thêm link
  chỉ để pass. → **#762** (Medium, chờ quyết định sản phẩm).
- **Group double-OTP** — gate session không thread vào `BookingGroupFlow` → group hỏi OTP lần
  2 sau Confirm. Không phải security bug (verify 2 lần). otp-gate **chưa sửa**. → **#763**
  (Medium, điều tra riêng).

## Bảo mật (không đổi)

Không bypass, demo `000000` trơ trong production (`isDemoOtpRuntime` false trừ khi `DEMO_OTP`),
không log code, không lộ trong URL, throttle/rate-limit còn nguyên. `gateOtpDone` chỉ set qua
`handleGateOtpVerified` sau khi verify API trả `ok+sessionId`; submit re-validate server-side.

## Kết quả trước/sau (chromium)

- Trước PR #764: non-RC chromium **15 fail** (7 booking-otp trong đó).
- Sau: non-RC chromium **9 fail** (−6). Full chromium **201 / 182 / 14 / 5** — **0 fail mới**.
- 14 fail còn lại đều đã-biết/có-chủ-đích: #261 tel-link (#762) + landing-funnel 7 (RC-7, #748)
  + otp-gate 1 (#763) + RC chromium 5 (#749).
- Required: Smoke ✅ · Build & Type Check ✅ · Security Audit ✅ · Secret scan ✅.
- Production: deploy trên `a60ea72`; routes khoẻ (home/salon 200, slug 404, dashboard/superadmin
  redirect đúng); **0 lỗi 500 mới**. Không gửi OTP thật, không tạo booking, không migration.
