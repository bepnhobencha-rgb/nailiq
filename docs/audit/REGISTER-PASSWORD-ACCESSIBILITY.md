# /register — accessibility ô mật khẩu (RC-8, đã sửa)

**Ngày:** 2026-07-16 · **PR:** #760 · **Merge:** `a96e073` (2026-07-16T12:03:19Z)
**Deploy:** `dpl_HGAW8ktw8ojEWtPiNQSXSFQRegCh` (production, READY) · **Issue:** #748 (phần B)

## Root cause

Ô mật khẩu `/register` (`SocialAuthButtons.tsx`, `id="password-input"`) chỉ được đặt tên
**bằng placeholder** (`t.passwordPlaceholder`), **không có `<label>` hay `aria-label`**.
Placeholder không phải accessible name ổn định: không phải screen reader nào cũng đọc như
label, và nó **biến mất khi người dùng gõ** → người khiếm thị / thị lực kém / suy giảm nhận
thức mất mục đích của ô nhập giữa chừng. Ô email ngay trên nó đã có `aria-label` → đây là sót
không nhất quán. axe (WCAG-AA) chấp nhận placeholder nên **không cờ**; check nghiêm hơn của
suite (`assertInputsHaveLabels`) mới bắt được.

## Cách sửa

Thêm `<label htmlFor="password-input">` **hiển thị thật**, dùng key i18n **có sẵn**
`t.passwordLabel` (EN **"Password"** / VI **"Mật khẩu"**) — **không thêm key mới, không hardcode**:

```tsx
<label htmlFor="password-input" className="text-sm font-semibold text-nq-foreground">
  {t.passwordLabel}
</label>
<Input id="password-input" type="password" placeholder={t.passwordPlaceholder} … />
```

Label bền (không biến mất khi gõ), cung cấp accessible name qua liên kết `for`↔`id`, khớp mẫu
label section của ô email, hợp UX "elderly-friendly" của bản redesign register. **Không đổi**
input type/name/validation/submit/auth flow/state/effect; placeholder giữ làm hint phụ.

## Test trước / sau

| Test | Trước | Sau |
|---|---|---|
| `a11y :: register :: axe scan` (`assertInputsHaveLabels`) | ❌ FAIL ("1 form control without an accessible name: password-input") | ✅ PASS |
| `a11y :: password field has a visible, associated label` (mới, copy-agnostic) | — | ✅ PASS |
| axe scan `/register` (WCAG-AA) | pass (axe vốn không cờ placeholder) | ✅ pass |

Test mới **fail nếu label bị xoá** (assert `label[for="password-input"]` visible + có text). Không
hardcode chuỗi "Password" → không hỏng locale khác.

## Kết quả

- **Chromium non-RC: 16 → 15 fail** (a11y hết đỏ, **0 fail mới**).
- Required: Smoke ✅, Build & Type Check ✅, Security Audit ✅, Secret scan ✅.
- **Production:** deploy READY trên `a96e073`; `/register` 200; SSR HTML chứa
  `<label for="password-input" …>Password</label>` (EN verified). VI ("Mật khẩu") resolve
  client-side sau hydration — cùng cơ chế `t.*` với label email đang chạy đúng VI. Không 500 mới.
- **Không** tạo user production, **không** gửi email/SMS, **không** migration.

### Kiểm chứng mobile — thành thật về phạm vi

**KHÔNG chạy được live mobile visual test** — Chrome extension không tạo được tab group trong
session này (dừng sau 3 lần theo nguyên tắc tránh rabbit-hole). **Không khẳng định** đã xem
trực tiếp trên viewport mobile. Thay vào đó, mobile được xác minh bằng:
1. **JSX dùng chung mọi viewport** — `<label>` không có nhánh render riêng cho mobile/desktop;
   cùng một cây DOM cho mọi kích thước màn hình.
2. **SSR HTML production có label** — cùng HTML phục vụ mọi viewport (đã thấy `<label
   for="password-input">Password</label>` trong response).
3. **Focused Playwright test PASS** — `label[for="password-input"]` visible + có text +
   `#password-input` có accessible name (chromium, trên chính code đã build).
4. **i18n key đã kiểm** — `passwordLabel` tồn tại EN "Password" / VI "Mật khẩu".

## Còn lại (#748 giữ mở)

Phần A của #748 — **7 test landing-funnel** (RC-7: heading `/register` đổi "Sign in or sign up"
→ "Get started with NailIQ", commit `6f77fcd`) — **CHƯA sửa**. Đó là stale copy phía test, nhóm
khác. Không đóng #748 tới khi phần landing-funnel xong.
