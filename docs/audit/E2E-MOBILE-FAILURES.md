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

### Mobile (baseline riêng — chỉ đo trên main full E2E)
- **non-RC shard:** pass **113** · fail **19** · skip **2** (134). ✅ đo được.
- **RC shard:** **KHÔNG đo được.** Matrix `[non-RC, RC]` bật **fail-fast**; non-RC luôn đỏ
  (honest red) và — vì mobile làm shard chạy lâu gấp đôi — non-RC kết thúc-fail TRƯỚC khi RC
  xong → RC shard bị **cancelled** mọi lần (kể cả khi rerun riêng job RC). Lấy được RC mobile
  đòi **fail-fast: false** trong workflow — **thay đổi config, ngoài scope NHÓM 22.**
- **Mobile-only fails (non-RC, ngoài tập chromium): 3** — feature-flag-toggle, bv-2,
  landing mobile-menu. (RC mobile có thể có thêm — chưa đo.)

### Combined (chromium + mobile — chỉ trên main full E2E)
- **Chromium (đầy đủ):** 200 / 175 / 21 / 4.
- **Mobile:** non-RC 134 / 113 / 19 / 2 **+ RC chưa đo** → **combined mobile chưa tính đủ.**
- **Combined chính xác chưa lập được** vì thiếu RC mobile. Đây là **giới hạn đo lường** (không
  bịa số): cần một run `fail-fast: false` để RC mobile chạy hết. Đề xuất cho nhóm sau, KHÔNG
  tự đổi trong NHÓM 22.

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
