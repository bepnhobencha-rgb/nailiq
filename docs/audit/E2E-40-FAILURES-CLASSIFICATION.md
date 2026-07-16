# E2E — Phân loại chính xác 40 lỗi (NHÓM 19)

**Ngày:** 2026-07-14
**Nhánh / commit:** `main` @ `5abe3c9`
**Nguồn số liệu:** run CI `29365053014` (post-CSP-fix, commit `0fd01cc`). Đã xác minh
code sinh ra các lỗi này **byte-identical** với `main` HEAD `5abe3c9`
(`git diff 0fd01cc 5abe3c9` chỉ chạm smoke helper + CI config + docs; `next.config.ts`
net-identical, CSP fix có mặt, **0 spec lỗi và 0 component liên quan thay đổi**). Run
mới khởi động trên `main` bị matrix fail-fast huỷ 2 shard giữa chừng nên không đếm lại
được — đồng nhất code là căn cứ để số liệu cũ chuyển sang `main`.

## Kết quả tổng

| Shard | Pass | Fail | Skip | Tổng |
|---|---|---|---|---|
| non-RC | 97 | 34 | 3 | 134 |
| receptionist-center | 58 | 6 | 2 | 66 |
| **TỔNG** | **155** | **40** | **5** | **200** |

Bằng baseline 155/40/5 → theo NHÓM 19 §1, con số này là **chính thức**.

**40/40 lỗi đều deterministic** (fail cả lần chạy gốc lẫn retry). **0 lỗi flaky thuần**
— ngoại lệ duy nhất là `drawer-group-cancel`, deterministic-theo-đồng-hồ (chỉ đỏ trong
khung ~20:00–21:00 UTC), xem RC-11.

## Kết luận đầu dòng

> **39/40 lỗi là bộ test tụt hậu so với sản phẩm. Đúng 1 lỗi sản phẩm thật (Medium).**
> Không có Critical, không có High. Không có double-booking, không có booking không hoàn
> tất, không có lễ tân bị chặn nghiệp vụ. Suite E2E đã "đỏ kinh niên" vì chính nó cũ,
> không phải vì app hỏng — và đó đúng là loại đỏ khiến một regression thật lọt qua giữa
> đám đèn đỏ mà không ai nhận ra.

Kiểm chứng bằng smoke: suite `Smoke (required)` (đọc booking ra khỏi Postgres) **xanh**
trên cùng `main` → booking công khai hoàn tất thật, RPC không bị chặn. Đây là điểm mấu
chốt để không lặp lại #747 (báo double-booking giả).

---

## Bảng 1 — Theo nguyên nhân gốc

| # | Nguyên nhân gốc | Số test | Phân loại | Mức | Ảnh hưởng người dùng thật | Deterministic | Issue | Hành động đề xuất |
|---|---|---|---|---|---|---|---|---|
| RC-1 | **Gate booking cần phone + tên + SMS consent**; spec cũ chỉ điền phone → service step không hiện | 9 | stale expectation | Low* | Không | Có | #746 | Chuyển spec public-booking sang helper `gotoBookingServiceStep` |
| RC-2 | Group: checkbox `group-sms-consent` bước 5 đã bỏ (consent thu ở gate) → `.check()` treo 90s | 8 | stale expectation | Low* | Không | Có | #746 | Xoá `.check()` bước 5 trong helper group |
| RC-3 | Group: spec tự chế gate nhét E.164 `+1604…` vào ô **national-number** → validate rớt, gate không mở | 5 | stale expectation | Low* | Không | Có | #746 | Điền national digits + tick `sms-consent` (đã có sẵn trong helper chuẩn) |
| RC-4 | Group: Guest 1 nay pre-fill tên gõ ở gate ("Test Guest"), spec đòi "Guest 1" | 2 | stale expectation | Low* | Không | Có | #746 | Assert member 0 = tên gate; "Guest 2/3" cho member 1..n |
| RC-5 | Group: OTP dời lên gate; spec đòi OTP hiện *sau* Confirm | 1 | stale expectation | Low* | Không | Có | #746 | Hoàn tất OTP ở gate rồi assert group đặt được |
| RC-6 | `bv-2`: chờ checkbox rồi mới `isVisible()` ô tên (checkbox render trước) → tên không điền | 1 | timing-race (test) | Low* | Không | Có | #746 | Chờ ô tên trực tiếp (như comment `db.ts` đã cảnh báo) |
| RC-7 | `/register`: H1 đổi "Sign in or sign up" → "Get started with NailIQ" (`6f77fcd`, 17/06); spec hardcode chuỗi cũ | 7 | stale expectation | Low* | Không | Có | #748 | Assert qua `data-testid` hoặc bundle i18n, không hardcode copy |
| RC-8 | **`/register`: ô mật khẩu chỉ đặt tên bằng placeholder — không `aria-label`/`<label>`** | 1 | a11y mismatch | **Medium** | **Có** (nhẹ) | Có | #748 | Thêm `aria-label` / `<label>` cho `#password-input` (**sửa SẢN PHẨM**) |
| RC-9 | RC mobile: `ReceptionistCenter` swap sang `VerticalDayView` sau hydration — component **không có testid** | 2 | stale expectation | Low* | Không | Có | #749 | Thêm testid vào `VerticalDayView` (khôi phục coverage mobile) |
| RC-10 | RC: owner home thay bằng dashboard analytics (`177c58e`); list booking cũ thành **code chết** | 2 | stale expectation | Low* | Không | Có | #749 | Retarget spec sang owner home mới; xoá `SalonOwnerTodayBookings.tsx` |
| RC-11 | RC: viền trái 3px nay mặc định mọi block (theme phong thuỷ `93a0bf4`); spec tin "viền trái = walk-in" | 1 | stale expectation | Low* | Không | Có | #749 | Assert icon nguồn walk-in thay vì border 0px |
| RC-12 | RC: party seed `now+3h`/`now+4h` vắt qua nửa đêm UTC → modal huỷ đếm partySize=1, ẩn nút huỷ-cả-nhóm | 1 | seed data | Low* | Không | Đồng-hồ | #749 | Seed giờ UTC cố định giữa ngày (vết `gotcha_nailiq_seed_wallclock_overlap`) |

\* *Low = ảnh hưởng chỉ ở sức khoẻ bộ test. Là **High với tư cách nhiễu**: 39 đèn đỏ giả
che mất tín hiệu thật.*

**Tổng: 12 nguyên nhân gốc.** 11 test-side, 1 product (RC-8).

---

## Bảng 2 — Theo từng test (40 dòng)

| # | File | Test | Route | Kỳ vọng | Thực tế | Phân loại | RC | Mức |
|---|---|---|---|---|---|---|---|---|
| 1-7 | `booking-otp.spec.ts` | 7 test OTP | `/[slug]` | service-tile-select hiện | Gate chưa mở (thiếu tên+consent) | stale | RC-1 | Low |
| 8-9 | `content/copy-check.spec.ts` | copy EN/VN | `/[slug]` | service-item hiện | Gate chưa mở | stale | RC-1 | Low |
| 10 | `booking-validation.spec.ts` | bv-2 phone formats | `/[slug]` | service-tile sau đổi phone | Tên không điền (race checkbox/name) | timing-race | RC-6 | Low |
| 11-18 | `group-booking/*` (guest-placeholder×2, seat-together×2, claim-tap, organizer-pre-claim, organizer-recognition, validation-errors) | 8 test | `/[slug]` group | `group-sms-consent` để tick | Checkbox đã bỏ → treo 90s | stale | RC-2 | Low |
| 19-20 | `group-booking/guest-placeholder.spec.ts` | Guest 1/2/3 prefill | `/[slug]` group | name = "Guest 1" | name = "Test Guest" (gate) | stale | RC-4 | Low |
| 21-25 | `group-booking/*` (guest-name-not-recognized×3, gate-new-customer-name, phone-first-gate) | 5 test | `/[slug]` gate | booking-entry-name/recognized | Gate không mở (E.164 vào ô national) | stale | RC-3 | Low |
| 26 | `group-booking/otp-gate.spec.ts` | always_otp | `/[slug]` gate | booking-type-group hiện | Ẩn tới khi gate-OTP xong | stale | RC-5 | Low |
| 27-33 | `landing-funnel.spec.ts` | 7 test CTA→register | `/` → `/register` | heading /sign in or sign up/i | H1 = "Get started with NailIQ" | stale | RC-7 | Low |
| 34 | `accessibility/a11y.spec.ts` | axe register | `/register` | mọi input có tên | `#password-input` không nhãn | a11y | RC-8 | **Medium** |
| 35 | `receptionist-center/mobile-layout.spec.ts` | case 7 | RC mobile | staff-timeline-grid | VerticalDayView (không testid) | stale | RC-9 | Low |
| 36 | `receptionist-center/drawer-responsive.spec.ts` | dr-2 | RC mobile | click booking-block-* | VerticalDayView (không testid) | stale | RC-9 | Low |
| 37 | `receptionist-center/grid-render.spec.ts` | case 5 | RC desk | borderLeft = 0px | 3px (accent mặc định) | stale | RC-11 | Low |
| 38 | `receptionist-center/owner-no-regression.spec.ts` | case 8 | Owner home | text "RC Display Appt" | Analytics-only, không list | stale | RC-10 | Low |
| 39 | `receptionist-center/owner-seat-together-badge.spec.ts` | badge 💕 | Owner home | text "RC Display Appt" | Analytics-only | stale | RC-10 | Low |
| 40 | `receptionist-center/drawer-group-cancel.spec.ts` | cancel-group-scope | RC drawer | cancel-group-scope hiện | partySize=1 (seed vắt nửa đêm) | seed | RC-12 | Low |

---

## Ưu tiên xác minh 4 luồng (theo yêu cầu)

- **A) Public booking** — smoke đọc-lại-DB **xanh** → luồng hoàn tất thật. 10 lỗi RC-1 là
  test không lái nổi gate mới, **không phải** booking hỏng.
- **B) Auth/registration** — 8 lỗi (RC-7, RC-8). Điều hướng `/register` đúng (mọi assert URL
  pass); form Google + email render. Đúng 1 defect thật: nhãn ô mật khẩu (RC-8).
- **C) Receptionist Center** — 6 lỗi, 0 chặn nghiệp vụ. Huỷ-cả-nhóm vẫn chạy
  (`cancel-whole-party.spec.ts` pass cùng shard). Mobile chạy đúng, chỉ đổi component.
- **D) Group booking** — 16 lỗi, 4 nguyên nhân, 0 product bug. Flag `group_booking_enabled`
  **được seed đúng** (`helpers.ts:55`) — không phải feature-flag.

---

## Đọc lại 3 issue với bằng chứng mới

- **#746** (public booking không qua gate) — **ĐÚNG, cập nhật**: bổ sung nguyên nhân chính
  xác (name + SMS consent + national-number phone) và gộp RC-1..RC-6 (17 test).
- **#748** (register: form + axe) — **TÁCH**: trộn 2 thứ không liên quan. RC-7 (7 test copy
  cũ, test-side) tách khỏi RC-8 (1 lỗi a11y sản phẩm thật). Bỏ mô tả dựa trên bằng chứng CSP cũ.
- **#749** (RC 7 spec) — **SỬA**: thực tế 6 test, và **không** có "sản phẩm hỏng". Cập nhật
  thành 4 nguyên nhân test-side (RC-9..RC-12); nêu rõ 2 quan sát LOW + 1 lỗ hổng coverage.

---

## Nhóm P0 kế tiếp (chỉ chọn, KHÔNG sửa trong NHÓM 19)

**P0 = RC-1/RC-2/RC-3/RC-4/RC-5/RC-6 — cụm phone gate của luồng Public Booking (26 test).**

> **Đính chính số học:** bản nháp trước ghi "17 test" ở mục này — sai. Cộng đúng RC-1..RC-6
> = 26 test (9 non-group + 16 group + 1 bv-2… chính xác: booking-otp 7 + copy-check 2 +
> bv-2 1 + group 16 = 26). Con số chính thức là **26**.

Lý do theo thứ tự ưu tiên đã cho (booking > wrong booking > auth > isolation > RC > a11y >
rest): không có product bug Critical/High, nên P0 là fix **khôi phục nhiều coverage nhất
trên luồng ưu tiên cao nhất (A — Public booking, đường doanh thu)**. Chuyển spec
public-booking + group sang helper chuẩn, thuần test-side, rủi ro thấp, và trả lại lá chắn
regression thật cho booking.

**NHÓM 20 thực thi (branch `test/public-booking-gate-current-flow`):** sửa **15/26** test
sạch (copy-check 2, bv-2 1, group consent-removed + Guest1 + gate-fix 12), **hoãn 11**:
- **8 OTP-gate** (booking-otp 7 + group/otp-gate 1) — salon `phone_otp_enabled` route OTP về
  gate; cần lái `GateOtpInline` (không có testid) + viết lại premise OTP-sau-info. Đúng
  "luồng OTP thuộc nhóm khác" → nhóm OTP riêng.
- **3 privacy** (guest-name-not-recognized) — **mâu thuẫn source**: comment
  `BookingTypeSwitcher.tsx:477-478` nói name input hiện cho khách *đã nhận diện trước OTP*,
  nhưng code dòng 479 (`!entryCustomer`) **ẩn** nó. Dừng & báo trước khi sửa (theo yêu cầu).

**Lưu ý:** RC-8 (nhãn ô mật khẩu) là **defect sản phẩm thật duy nhất** — tách thành fix
riêng (Medium, sửa source), nhưng **không** phải P0 vì không chặn luồng chính (đã có tên
fallback từ placeholder).

## 2 quan sát sản phẩm LOW (ghi nhận, không claim blocker)

1. `showWalkinAccent` + `isWalkin` nay là prop/biến chết sau commit theme phong thuỷ — flag
   `vip_indicators` thành no-op. Walk-in vẫn nhận ra qua icon nguồn. Nên gỡ hoặc nối lại.
2. Nút huỷ-cả-nhóm tính `partySize` từ `bookingsForDay` (theo ngày) trong khi panel drawer
   báo "PARTY OF 2" (không theo ngày) — 2 nguồn sự thật cho cùng 1 party. Bất khả đạt ở prod
   (party không vắt nửa đêm) nên **không** phải High; nên gom về 1 nguồn party.

## Lỗ hổng coverage thành thật (không dám kết luận)

Vì `drawer-responsive dr-2` không click nổi booking trên mobile (RC-9), hiện **không có bằng
chứng nào** về việc booking drawer có vừa màn hình 375px hay không — assertion đó đã chết âm
thầm. Không claim hỏng, cũng không claim ổn. **Cần repro local** sau khi RC-9 được sửa.

---

## Cập nhật NHÓM 26 (2026-07-16) — RC-8 ĐÃ SỬA

**RC-8** (product bug thật duy nhất trong 40 lỗi: ô mật khẩu `/register` chỉ có placeholder,
thiếu accessible name) — **đã sửa** qua **PR #760** (merge `a96e073`): thêm
`<label htmlFor="password-input">` dùng i18n `t.passwordLabel` (EN "Password"/VI "Mật khẩu").
`register :: axe scan` PASS + test focused mới PASS. **Chromium non-RC 16 → 15 fail, 0 fail mới.**
Chi tiết: `REGISTER-PASSWORD-ACCESSIBILITY.md`. Còn lại của #748 = 7 test landing-funnel (RC-7).

---

## Cập nhật NHÓM 28/29 (2026-07-16) — OTP-gate test debt xử lý

6 test booking-otp (OTP stale) khôi phục theo luồng gate-first OTP → **PR #764** (merge `a60ea72`).
Source chỉ thêm `data-testid` behavior-neutral. Sau PR #766 (fix #762+#763): chromium 184 pass / 12 fail (test debt). Bảo mật
OTP giữ nguyên. #754 đóng. Tel-link gap → **#762** (test #261 giữ đỏ). Group double-OTP → **#763**.
Chi tiết: `OTP-GATE-TEST-REMEDIATION.md`.
