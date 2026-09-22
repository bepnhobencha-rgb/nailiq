# NailIQ Masterplan — Ngày 3: Đăng ký Google

Cập nhật: 22/09/2026

Nhánh QA: `qa/masterplan-day2-day3-closeout-20260922`

Preview: `https://nailiq-p0-signup-qa-20260911.vercel.app`

Supabase QA disposable: `uhpzafoiifupyypkcwln`

## Kết luận

**PASS HOSTED QA cho lần đăng ký Google đầu tiên, callback, tạo salon riêng tư,
chống trùng identity/salon và callback recovery.** Chưa phải Production hoặc
pilot proof.

## 1. Cấu hình QA đã kiểm chứng

- Google provider bật riêng trên Supabase QA bằng OAuth client QA của project
  Google `nailiq-496218`.
- Site URL và redirect allow-list chỉ tới stable QA Preview và `/auth/callback`.
- Preview branch dùng Supabase QA URL/anon/service-role key riêng.
- SMS, email, call, payment và provider ngoài Google Auth đều OFF/sandbox.
- Không thay đổi Production hoặc salon Live.

## 2. Đăng ký Google thật trên hosted Preview

Danh tính QA được chủ tài khoản cho phép: `thehuytgvn@gmail.com`.

Trước test, lookup chính xác trong QA trả `0` user. Hành trình UI thực tế:

1. Bấm **Continue with Google** trên Preview.
2. Chọn đúng Google identity đã cho phép và hoàn tất consent name/email.
3. Callback quay về `/register/setup`.
4. Tạo salon `Google OAuth QA Salon 20260922` /
   `google-oauth-qa-salon-20260922`.
5. UI xác nhận salon riêng tư, chưa Live, không SMS/email và không payment.

Database readback sau tạo:

- đúng một user, provider `google`;
- đúng một owner membership và một salon;
- private/off defaults được giữ;
- plan `free`, status `trialing`, đúng 14 ngày trial;
- 10 dịch vụ mẫu và 1 staff mặc định.

## 3. Existing identity và chống trùng

Thực hiện provider re-authorization bằng cùng Google identity trong phiên browser
hiện có. Hệ thống quay lại đúng dashboard salon đã tạo; database vẫn chỉ có một
user, một membership và một salon — không tạo bản sao.

Giới hạn bằng chứng: đây là re-auth/provider return trong phiên browser hiện có,
không phải một lượt đăng nhập sạch trên browser/device hoàn toàn khác. Một probe
trực tiếp ngoài app initiator không có PKCE đã trả token trong URL fragment; URL
được scrub ngay, token không được ghi lại và probe đó không được dùng để tuyên bố
PASS cho app login-button PKCE. Lần đăng ký đầu tiên qua nút thật của app đã PASS.

## 4. Callback recovery hosted

Fresh headless browser với Vercel QA bypass hợp lệ mở callback thiếu session/PKCE:

```text
finalPath: /login
errorCode: session
hasRetryCopy: true
hasGoogleButton: true
```

Kết quả: fail-visible, có hướng dẫn thử lại và không tạo user/salon.

## 5. Bằng chứng tự động liên quan

- Google recovery desktop/mobile EN/VI: **12/12 PASS**.
- Callback, membership và email/password auth: **39/39 PASS**.
- Salon registration action, tenant boundary, choose-salon và onboarding:
  **30/30 PASS**.
- Production build: **PASS**.

## 6. Cleanup và trạng thái cuối

- Đã xóa Google synthetic user và salon synthetic.
- Lookup sau cleanup trả đúng `0` user cho identity QA trong Supabase QA.
- Temporary QA platform-flag override đã được xóa; trạng thái trở về absent.
- Không tạo booking, không gửi email/SMS/call, không thu tiền.
- Không chạm Production hoặc hai salon Live.

Ngày 3 được đóng ở mức **PASS HOSTED QA**. Phần còn lại cho nghiệm thu phát hành
là clean-browser/device return-login nếu muốn nâng mức bằng chứng, và pilot người
thật; hai việc đó không phủ định kết quả QA hosted hiện tại.
