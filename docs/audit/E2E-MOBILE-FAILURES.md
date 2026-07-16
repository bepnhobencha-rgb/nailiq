# E2E — Lỗi mobile & chuẩn hoá baseline chromium/mobile (NHÓM 22)

**Ngày:** 2026-07-15
**Nguồn:** run main `29401453758` (commit `acc7d016`, sau merge PR #753), CI Supabase Local.
**Phạm vi NHÓM 22:** chỉ GHI NHẬN + chuẩn hoá báo cáo. **Không sửa source/test, không merge, không deploy.**

## Bối cảnh — vì sao mobile mới lộ ra

- **PR checks chạy `chromium`-only** (200 test). Baseline NHÓM 19 (40 fail) và số PR #753
  (175/21/4) đều là **số chromium**.
- **Main full E2E chạy CẢ `chromium` + `mobile`** (mỗi project ~200 test). Project `mobile`
  chưa từng được đo trên PR → khi merge vào main mới lộ các lỗi mobile.
- **Smoke (required) chạy `chromium`** (8 test) — đó là cổng merge, đã xanh.

→ **Không được lấy số chromium-only của PR để so trực tiếp với run chromium+mobile của main.**

## Ba lỗi mobile-only (fail trên mobile, PASS trên chromium)

Lưu ý: user NHÓM 22 nêu 2 lỗi; điều tra tìm thêm lỗi **thứ 3** (landing-funnel mobile-menu,
cùng root cause RC-7 đã track).

| Test | Project | Phân loại | Deterministic | Ảnh hưởng user thật | Severity | Issue | Next action |
|---|---|---|---|---|---|---|---|
| `superadmin/feature-flag-toggle.spec.ts` :: toggle ON then OFF (`:79`) | mobile | auth/navigation race (superadmin) | Có (2/2 fail) | Không (test-only; superadmin nội bộ) | Low | #754 | Nhóm "superadmin mobile login race" (đã biết) |
| `booking-validation.spec.ts` :: bv-2 valid phone formats (`:71`) | mobile | mobile gate timing | Có (2/2 fail) | **Chưa xác định** (cần repro mobile thật) | Medium (nghi ngờ) | #754 | Nhóm "public booking mobile gate timing" |
| `landing-funnel.spec.ts` :: mobile menu Try Free → /register | mobile | stale copy (RC-7) | Có | Không | Low | #748 | Cùng fix RC-7 (heading `/register` đổi) |

### A. `feature-flag-toggle [mobile]`
- **File/test:** `e2e/superadmin/feature-flag-toggle.spec.ts` :: "toggle ON then OFF — each persists and writes a matching audit row" (`:79`)
- **Route:** `/superadmin/operations/feature-flags`
- **Project:** mobile (WebKit).
- **Expected:** điều hướng tới trang feature-flags, toggle ON/OFF, ghi audit row.
- **Actual:** `Error: page.goto: Navigation to "http://localhost:3000/superadmin/operations/feature-flags"` **thất bại** — chưa vào được trang.
- **Error:** `page.goto` navigation fail (không phải assertion nghiệp vụ).
- **Artifact:** screenshot, video, error-context, trace (run 29401453758 shard1 mobile).
- **Deterministic:** Có — 2/2 attempt (gốc + retry) đều fail.
- **Nguyên nhân:** superadmin login/navigation race trên mobile — khớp gotcha đã ghi
  (`loginAsSuperadmin`+goto flakes mobile). Điều hướng fail TRƯỚC mọi assertion nghiệp vụ.
- **Ảnh hưởng production:** KHÔNG — superadmin là surface nội bộ; đây là vấn đề setup test
  trên mobile WebKit, không phải luồng người dùng.
- **Không do PR #753:** PR đụng 0 file auth/superadmin. Chắc chắn.
- **Severity tạm:** Low. **Workaround:** chạy superadmin E2E trên project desktop, hoặc ổn
  định `loginAsSuperadmin` cho mobile (nhóm sau).

### B. `bv-2 [mobile]`
- **File/test:** `e2e/booking-validation.spec.ts` :: "bv-2: valid phone formats at the gate reveal the service step" (`:71`)
- **Route:** `/[slug]` (public booking gate).
- **Project:** mobile (WebKit).
- **Expected:** nhập phone hợp lệ → name input hiện → điền tên + consent → service step hiện.
- **Actual:** `TimeoutError: locator.waitFor: Timeout 8000ms exceeded` — `booking-entry-name`
  không visible trong 8s trên mobile.
- **Timeout tại:** `nameInput.waitFor` (8s) — đúng dòng fix NHÓM 20 chờ name input.
- **Deterministic:** Có — 2/2 attempt fail.
- **Chromium PASS:** **Có** — bv-2 xanh trên chromium (fix NHÓM 20 đúng cho chromium).
- **Có phải mobile gate timing:** Nghi ngờ đúng — trên WebKit, name input (sau lookup ~400ms)
  không xuất hiện trong 8s. Bản CŨ cũng fail trên mobile (check `isVisible()` tức thì → bỏ
  qua điền tên → service step không mở) → **không phải regression của PR #753**.
- **Ảnh hưởng người dùng mobile thật:** **CHƯA XÁC ĐỊNH** — chưa repro UX sai trên thiết bị
  mobile thật. Có thể chỉ là timing của CI/WebKit, cũng có thể là gate chậm thật trên mobile.
  **Không gọi là product bug tới khi repro ổn định.**
- **Severity tạm:** Medium (nghi ngờ — vì chạm luồng booking mobile). **Workaround:** không
  có trong nhóm này; nhóm sau điều tra repro mobile thật trước khi quyết fix test hay source.

### C. `landing-funnel mobile-menu [mobile]` (lỗi thứ 3)
- **File/test:** `e2e/landing-funnel.spec.ts` :: "mobile menu Try Free navigates to /register".
- **Project:** mobile (test tự skip trên chromium → chỉ chạy mobile).
- **Phân loại:** **stale copy (RC-7)** — cùng root cause 7 test landing-funnel chromium
  (heading `/register` đổi "Sign in or sign up" → "Get started with NailIQ", commit `6f77fcd`).
- **Ảnh hưởng user:** Không. **Severity:** Low. **Issue:** #748 (RC-7). Sẽ hết khi fix RC-7.

## Baseline chuẩn hoá theo project

> **Số điền từ run main `29401453758` (chromium+mobile) + branch run chromium.** RC mobile lấy
> từ rerun riêng job RC (fail-fast huỷ RC shard ở lần chạy đầu).

### Chromium (baseline chính thức — áp cho PR checks + Smoke)
- **Tổng 200 · Pass 175 · Fail 21 · Skip 4** (branch run PR #753, chromium-only, 2 shard).
- 21 fail: booking-otp 7 + otp-gate 1 (OTP, #754) + landing-funnel 7 (RC-7, #748) + a11y 1
  (RC-8, #748) + RC 5 (#749). bv-2 + feature-flag-toggle **PASS** trên chromium.

### Baseline ĐẦY ĐỦ — clean run `29444451203` (NHÓM 24, commit `de29837`)

Sau khi **PR #757** nâng `timeout-minutes` 65 → 120, RC+mobile shard **chạy trọn** (RC:
19:26:12 → 20:37:46 = **71m34s** < 120) → **lần đầu tiên** có số Mobile RC + Combined.

| Nhóm | Total | Pass | Fail | Skip |
|---|---|---|---|---|
| Chromium non-RC | 134 | 115 | 16 | 3 |
| Chromium RC | 66 | 59 | 5 | 2 |
| **Chromium TOTAL** | **200** | **174** | **21** | **5** |
| Mobile non-RC | 134 | 113 | 19 | 2 |
| Mobile RC | 66 | 29 | **34** | 3 |
| **Mobile TOTAL** | **200** | **142** | **53** | **5** |
| **COMBINED** | **400** | **316** | **74** | **10** |

> Chromium run này 174/21/5 so với baseline 175/21/4: **fail giữ nguyên 21** (không lỗi mới),
> chỉ 1 test dịch pass↔skip (variance test-order, không phải regression).

**Vì sao Mobile RC bị kill trước đây (đính chính lịch sử):** KHÔNG phải fail-fast (`false` sẵn)
và KHÔNG phải cancel-in-progress. Là **`timeout-minutes: 65`** — mobile RC fail retry ~45-90s
mỗi cái → RC+mobile vượt 65 phút → job killed (run `29438056294`: RC đúng 65m36s). PR #757 sửa.

### Lỗi mobile-only (fail mobile, PASS/skip chromium): **32**
- **3 đã biết** (non-RC): feature-flag-toggle (superadmin race), bv-2 (gate timing) → #755;
  landing mobile-menu (RC-7) → #748.
- **29 MỚI (RC):** Receptionist Center fail hàng loạt trên mobile — **test debt** (RC E2E nhắm
  grid desktop `staff-timeline-grid`/`booking-block-*`; mobile render `VerticalDayView` không
  testid). Xác minh bằng locator từ clean run. Tách sang **#758**. Không phải product bug ở
  tầng test; bed-picker có 2 assertion cần soi riêng.

### Both-fail (chromium + mobile): 21 — tập chromium đã biết (booking-otp, landing-funnel,
a11y, otp-gate, 5 RC). Không đổi.

**Hạ tầng clean run:** cả 2 shard mọi bước success (Supabase start, preflight/guard, schema
parity, seed, seed-idempotent, server boot 30s, sweep, **supabase stop**). Chỉ "Run E2E tests"
= failure (đỏ thật). **0 production secret, 0 production write.**

> **Chromium RC (tham chiếu, suy từ branch run chromium):** non-RC chromium 115/16/3 + tổng
> chromium 175/21/4 → RC chromium ≈ 60/5/1. Mobile RC không có số tương ứng.

## Ai chạy project nào

| Gate | Project chạy | Required? | Baseline áp dụng |
|---|---|---|---|
| Smoke | chromium | **Có** (merge gate) | 8/8 pass |
| PR full E2E | **chromium-only** | Không | Chromium 175/21/4 |
| Main full E2E (push) | chromium **+ mobile** | Không | Chromium 175/21/4 + Mobile riêng |
| Build & Type Check / Security Audit | — | **Có** | — |

## Không làm trong NHÓM 22
Không sửa source/test/selector, không tăng timeout, không thêm retry, không skip, không merge,
không deploy, không migration, không đổi production data. Chỉ rerun CI + thu artifact + cập
nhật issue + viết báo cáo.
