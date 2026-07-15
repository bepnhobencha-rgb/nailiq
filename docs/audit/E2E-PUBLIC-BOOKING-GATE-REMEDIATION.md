# E2E — Cập nhật Public Booking Gate theo luồng sản phẩm hiện tại (NHÓM 20)

**Ngày:** 2026-07-15
**Branch:** `test/public-booking-gate-current-flow` (base `main` @ `5abe3c9`)
**Phạm vi:** chỉ sửa TEST + helper. **Không đổi một dòng source/business logic nào.**
`git diff --stat` chỉ chạm `e2e/**` và `docs/**` — 0 file `src/`.

## Business rule của gate (xác nhận từ source, không đổi)

`src/components/booking/BookingTypeSwitcher.tsx`:
- `nameOk = Boolean(entryCustomer) || entryName.trim().length >= 2` (:360) — khách đã nhận
  diện thì auto-đủ tên; khách mới cần ≥2 ký tự.
- `gateReady = Boolean(entryPhone) && nameOk && entrySmsConsent` (:362) — **phone + tên +
  SMS consent**.
- `flowReady = gateReady && (!salon.phoneOtpEnabled || gateOtpDone)` (:620) — salon bật OTP
  thì **gate-OTP là điều kiện thứ tư**.
- Service step (`service-tile-select`) và `booking-type-group` chỉ render khi `flowReady`.

Phone nhập vào `booking-entry-phone` là ô **national number** của `CountryPhoneField` — nhập
E.164 đầy đủ (`+1604…`) sẽ bị cắt thành area code rác và gate không mở. Đây là gốc rễ RC-3.

## Helper chuẩn (single source of truth)

`e2e/helpers/db.ts` — thêm `completeBookingEntryGate(page, { phone?, name?, keepProfile? })`:
điền phone (national) + tên + tick `sms-consent`, chờ đúng name input (không chờ checkbox).
`gotoBookingServiceStep` và `gotoGroupFlow` (group helpers) nay **uỷ quyền** cho nó — hợp
đồng gate sống ở đúng một chỗ, để lần sau product đổi gate chỉ sửa một nơi. Thêm hằng
`GATE_NAME` để spec assert giá trị product pre-fill mà không hardcode chuỗi.

**Không làm yếu gate, không bỏ qua consent:** consent vẫn được tick — nay ở gate (đúng nơi
product thu). Các dòng `group-sms-consent.check()` bước 5 bị gỡ vì checkbox đó chỉ render khi
`!smsConsent`, mà consent đã cho ở gate → checkbox vắng (gỡ để hết treo 90s, KHÔNG phải bỏ
consent).

## 15/26 test đã sửa (thuần test-side)

| File | Test | RC | Sửa gì |
|---|---|---|---|
| `content/copy-check.spec.ts` | 2 | RC-1 | Thay khối gate tự chế (nhập E.164) bằng `completeBookingEntryGate` |
| `booking-validation.spec.ts` | bv-2 | RC-6 | Chờ **name input** trực tiếp thay vì checkbox-rồi-`isVisible()` (hết race) |
| `group-booking/claim-tap-your-name.spec.ts` | 1 | RC-2 | Gỡ `group-sms-consent.check()` bước 5 |
| `group-booking/organizer-pre-claim.spec.ts` | 1 | RC-2 | Gỡ consent bước 5 |
| `group-booking/organizer-recognition.spec.ts` | 1 | RC-2 | Gỡ consent bước 5 |
| `group-booking/validation-errors.spec.ts` | 1 | RC-2 | Gỡ consent bước 5; giữ nguyên assert Confirm-enables |
| `group-booking/seat-together.spec.ts` | 2 | RC-2 | Gỡ consent bước 5 (2 chỗ) |
| `group-booking/guest-placeholder.spec.ts` | 2 | RC-2 | Gỡ consent bước 5 (2 chỗ) |
| `group-booking/guest-placeholder.spec.ts` | 2 | RC-4 | Assert member 0 = tên organizer (`GATE_NAME`), member 1+ = Guest 2/3 |
| `group-booking/gate-new-customer-name.spec.ts` | 1 | RC-3 | Phone national + tick consent trước khi vào group |
| `group-booking/phone-first-gate.spec.ts` | 1 | RC-3 | Phone national + tick consent |

Refactor `gotoGroupFlow` (uỷ quyền helper) cũng bỏ chặn RC-1/RC-3 ẩn cho toàn bộ group suite.

## 11 test HOÃN (có lý do, để đỏ thật — không skip, không giảm assertion)

### 8 test — luồng OTP-gate (nhóm OTP riêng)
`booking-otp.spec.ts` (7) + `group-booking/otp-gate.spec.ts` (1). Cả hai seed salon
`phone_otp_enabled: true` + `always_otp`, nên OTP đã **dời lên gate** (`GateOtpInline`):
`flowReady` cần `gateOtpDone`. Thêm phone+name+consent **vẫn không mở** được gate.
Hoãn vì:
1. `GateOtpInline` **không có `data-testid` nào** — lái nó bền vững cần thêm testid vào
   source (ngoài phạm vi "cập nhật test").
2. Premise cũ của `booking-otp` ("OTP hiện sau info step") đã chết — OTP nay trước bước chọn
   dịch vụ. Cần **viết lại**, không phải chỉnh gate.
Đây đúng "luồng OTP thuộc nhóm khác" đã được dặn không chạm trong PR này.

### 3 test — mâu thuẫn source, DỪNG & BÁO
`group-booking/guest-name-not-recognized.spec.ts` (3) khẳng định: với phone **đã nhận diện**,
`booking-entry-name` hiện (để khách tự nhập tên). Nhưng:
- **Comment** `BookingTypeSwitcher.tsx:477-478`: *"Name input: shown for new customers **and
  returning ones before OTP**."* → khớp test.
- **Code** `:479`: `{entryPhone && !entryLoading && !entryCustomer ? (…name input…) : null}`
  → `!entryCustomer` **ẩn** name input cho khách đã nhận diện. → nghịch test.

Comment và code đá nhau. Nếu "sửa" test để mong name input **ẩn** mà thực ra code đúng-theo-
comment (tức đang có bug ẩn name input cho khách cũ), ta sẽ **che mất một product bug**. Theo
yêu cầu NHÓM 20 ("Nếu source và tài liệu mâu thuẫn, dừng và báo trước khi sửa test"), **để
nguyên 3 test**, chờ chốt: name input CÓ nên hiện cho khách đã nhận diện trước OTP không?
- Nếu **có** (comment đúng) → đây là **product bug** (code dòng 479 sai), test giữ nguyên, mở
  issue sửa source.
- Nếu **không** (code đúng) → cập nhật comment + 3 test (bỏ assert name-input, giữ assert
  privacy "không lộ tên").

## Xác nhận môi trường

- Branch riêng, không đụng `main`; Branch Protection còn nguyên (Smoke required + enforce_admins).
- Verify chạy trên **CI với Supabase Local** (Docker/Supabase CLI không có trên máy local) —
  không production secret, không ghi production. `npx tsc --noEmit` sạch; eslint sạch.

## Không làm

Không skip test, không giảm assertion, không thêm retry, không `continue-on-error`, không đổi
business logic, không merge, không deploy.
