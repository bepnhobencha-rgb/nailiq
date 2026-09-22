# Masterplan Ngày 2 — Đăng ký salon mới từ A đến Z

Ngày kiểm tra: 22/09/2026
Mã nguồn: `a78950cd9f9b4d9106eda81df10dbb00d3731d41` (`origin/main`)
Phạm vi: email/password → email confirmation → callback/login recovery → salon trắng → trial 14 ngày → Dashboard/Coco Setup.
Kết luận phạm vi: **PASS QA LOCAL; HOSTED PREVIEW AUTH-WALLED; GOOGLE OAUTH NOT PROVEN**.

## 1. Ranh giới an toàn

- Dùng worktree riêng và Supabase local disposable, không dùng dữ liệu salon thật.
- Email xác nhận chỉ đi vào Mailpit cục bộ; Resend, SMS, call và payment/provider đều tắt.
- Không tạo booking, không gửi thông báo thật, không sửa Production.
- Không commit, push, tạo PR, merge hoặc deploy.

## 2. Môi trường đã kiểm chứng

- Production build cục bộ của đúng SHA trên: **PASS**.
- Schema QA được dựng từ folded baseline + 269 forward migrations.
- Schema parity: **246 tables, 3,803 columns, 225 policies, 600 functions,
  169 triggers, 1,012 indexes — tất cả khớp release contract**.
- RLS bật trên toàn bộ core tables; grant matrix khớp release contract.
- Preview PR #1418 hiện có deployment `Ready`, nhưng URL yêu cầu đăng nhập
  Vercel. Vì không tạo share-bypass hoặc thay đổi cấu hình Preview trong phạm
  vi này, hosted Preview UI được ghi **NOT PROVEN**, không suy diễn từ local.

## 3. Kết quả tự động trên production build cục bộ

### Luồng signup/email confirmation đầy đủ

Lệnh:

```text
npx playwright test e2e/auth-signup-confirmation.spec.ts --project=chromium --reporter=list
npx playwright test e2e/auth-signup-confirmation.spec.ts --project=mobile --reporter=list
```

Kết quả:

- Desktop Chromium: **10/10 PASS**.
- Mobile WebKit/iPhone 14 profile: **10/10 PASS**.
- EN và VI đều PASS.
- Email thật trong Mailpit, tài khoản còn unconfirmed trước khi bấm link.
- Không thể vào setup trước confirmation.
- Link confirmation tạo Secure session; reload vẫn giữ session.
- Salon mới có owner membership, private workspace và đúng 14 ngày trial.
- Không có Stripe customer/subscription/payment provider; email/SMS outbound OFF.
- Đăng nhập lại không tạo salon thứ hai hoặc khởi động lại trial.
- Resend sau cooldown 60 giây PASS.
- Mở link ở browser khác hiển thị hướng dẫn PKCE và password fallback PASS.

### Copy, callback, auth guard và tạo salon

Lệnh:

```text
npx playwright test e2e/register.spec.ts e2e/auth-register-copy.spec.ts \
  e2e/register-success-auth-guard.spec.ts e2e/auth-email-callback.spec.ts \
  --project=chromium --reporter=list
```

Kết quả liên quan Ngày 2: **18 PASS**.

- Callback lỗi/thiếu code/link hết hạn có thông báo EN/VI.
- Callback PKCE thật, link dùng lại, owner cũ và browser khác đều được kiểm tra.
- Thứ bậc nút đăng ký rõ ở EN/VI; một `main` landmark; cảnh báo đạt kiểm tra
  color contrast.
- Người chưa đăng nhập không render được trang success giả.
- Owner mới tạo salon, trial 14 ngày, không cần thẻ và vào đúng Dashboard.

Một ca `Returning owner › Phone sign-in` timeout vì server của đợt này cố ý
chạy `DEMO_OTP=false` để kiểm email confirmation thật; form phone demo không
tồn tại trong cấu hình này. Ca đó không thuộc đường email/password Ngày 2 và
không được tính thành lỗi sản phẩm.

## 4. Computer Use — thao tác như chủ salon thật

Tài khoản synthetic: `day2-owner-20260922-0203@example.com` (đã dọn sau test).
Salon synthetic: `Day 2 QA Nail Studio` / `day-2-qa-nail-studio` (đã dọn sau test).

Hành trình đã thao tác trực tiếp:

1. Mở `/register?intent=trial`, đổi English → Tiếng Việt.
2. Nhập email/password và bấm **Đăng ký**.
3. Thấy màn hình **Kiểm tra email để hoàn tất**, đúng recipient và cooldown.
4. Mở Mailpit, kiểm tra một email confirmation duy nhất.
5. Xác nhận tài khoản; khi browser automation không đi tiếp được qua HTTPS
   fixture, đăng nhập lại bằng password theo đúng recovery đã thiết kế.
6. Vào `/register/setup`, nhập tên salon; slug tự đổi thành
   `day-2-qa-nail-studio`; timezone mặc định `America/Vancouver`.
7. Tạo workspace; thấy bước 3/3, nhãn **Salon của bạn chưa Live**, booking,
   notification và payment/provider đều được mô tả là chưa bật.
8. Bấm **Bắt đầu Coco Setup**; vào đúng
   `/dashboard/day-2-qa-nail-studio/setup`.
9. Mở URL booking công khai của salon mới; hệ thống chặn và hiển thị
   **Tạm dừng nhận đặt lịch**.

Database readback cho salon synthetic:

- role `owner`;
- `subscription_status=trialing`, `subscription_plan=free`;
- chênh lệch `trial_ends_at - trial_started_at = 14.00 ngày`;
- `profile_complete=false`;
- SMS, email, reminders, Voice AI và Stripe Connect charges đều `false`;
- `payment_provider=NULL`;
- 10 dịch vụ mẫu và 1 staff mặc định.

## 5. Nhận xét UX

### Đạt

- Copy đăng ký EN/VI đơn giản, nêu rõ 14 ngày và không cần thẻ.
- Bước tạo salon giải thích đúng “tên tiệm, không phải tên cá nhân”.
- Safe-start rất rõ: salon riêng tư, chưa booking, chưa nhắn khách, chưa thu tiền.
- Success screen và Coco Setup đều cho biết việc tiếp theo; không có màn hình chết.
- Mobile automated journey PASS toàn bộ 10 ca signup/confirmation.

### Chưa 10/10 nhưng không chặn đường email Ngày 2

1. **Hai thước tiến độ cạnh nhau có thể làm chủ tiệm mới bối rối:** Coco Setup
   hiển thị `25% / 2 of 8 required steps` và `13% / 2 of 15 functions` trong
   cùng phần đầu. Nên chọn một tiến độ chính, đưa “15 chức năng” xuống chi tiết.
2. **Danh sách timezone lệch tuyên bố thị trường trong repo:** có Việt Nam nhưng
   chưa có timezone châu Âu, trong khi policy repo ghi US/Canada/Europe và không
   bán thị trường Việt Nam nội địa. Cần quyết định sản phẩm trước khi sửa.
3. **Hosted Preview chưa có bằng chứng thao tác đăng ký:** deployment bị Vercel
   Authentication chặn. Local production build và CI xanh không thay thế hosted
   Preview E2E.
4. **Google OAuth chưa được kiểm chứng trong đợt này.** Không dùng local mock để
   tuyên bố provider PASS.

## 6. Kết luận và bước kế tiếp

- Email/password signup của SHA hiện tại: **PASS QA** trên desktop và mobile.
- Salon trắng, owner, trial 14 ngày, private/off defaults và Dashboard: **PASS QA**.
- Hosted Preview, Google OAuth và provider delivery: **NOT PROVEN**.
- Ngày 2 chưa thể đóng toàn bộ P0-02 cho tới khi có một Preview an toàn trỏ QA,
  share-bypass có thời hạn và một lượt Google OAuth QA được chủ tài khoản duyệt.
