# NailIQ Masterplan — Ngày 3: Đăng ký Google

Cập nhật: 22/09/2026
Nền kiểm tra: `origin/main` / `a78950cd9f9b4d9106eda81df10dbb00d3731d41`
Nhánh closeout: `qa/masterplan-day2-day3-closeout-20260922`

## Kết luận

**PASS_LOCAL cho hợp đồng ứng dụng; NOT_PROVEN cho Google OAuth thật trên QA.**

Ứng dụng đã vượt qua các tình huống local an toàn: tài khoản mới, tài khoản đã
có salon, tài khoản nhiều salon, callback thiếu PKCE như khi mở ở trình duyệt
khác, lỗi khởi tạo và thử lại, EN/VI, desktop/mobile. Cơ chế đăng ký hiện tại
không tạo salon thứ hai cho tài khoản đã có salon.

Không thể ký nghiệm thu Google signup end-to-end trên môi trường hosted hiện
tại vì Google provider của Supabase QA đang **OFF** và Preview PR #1418 không
có bộ biến Supabase QA riêng theo branch. Không được dùng Preview đó để tạo user
thử vì chưa chứng minh nó tách khỏi Production.

## Bằng chứng đã kiểm tra

### 1. Supabase QA — read-only

Project QA: `uhpzafoiifupyypkcwln` (`nailiq-p0-03-qa-20260921`). Endpoint Auth
trả healthy, signup mở, email provider bật và Google provider tắt:

```text
auth healthy: true
signupDisabled: false
emailEnabled: true
googleEnabled: false
enabledProviders: [email]
```

Không đọc/in secret. Không thay đổi cấu hình Auth, redirect allow-list, user hay
database. Kiểm tra read-only Production không được dùng làm bằng chứng vì key
quản trị cũ trả HTTP 401.

### 2. UI browser local — provider bị chặn

Lệnh cuối:

```sh
NEXT_PUBLIC_SITE_URL=http://localhost:3000 \
NEXT_PUBLIC_DEMO_OTP=false DEMO_OTP=false \
DISABLE_OUTBOUND_SMS=1 DISABLE_OUTBOUND_EMAIL=1 DISABLE_OUTBOUND_CALLS=1 \
npx playwright test e2e/google-auth-recovery.spec.ts \
  --project=chromium --project=mobile
```

Kết quả cuối: **12/12 PASS**, không retry, không skip. Một lượt đầu chạy
nhầm web server mặc định `DEMO_OTP=true` nên `/login` cố ý chỉ hiện phone OTP;
lượt đó bị loại khỏi bằng chứng. Lượt WebKit khác dùng site URL HTTPS cho server
HTTP khiến asset bị nâng cấp và TLS fail; trace xác nhận đúng lỗi harness. Lượt
PASS cuối chạy server với `NEXT_PUBLIC_SITE_URL=http://localhost:3000` và các
kênh outbound đều tắt.

- Chrome desktop và iPhone WebKit.
- English và Tiếng Việt.
- `/login` và `/register`.
- In-app browser giữ Google disabled nhưng email signup vẫn dùng được.
- Lỗi tạo PKCE giữ nguyên email/mật khẩu đã nhập và cho retry.
- Retry tạo đúng một handoff: provider `google`, PKCE `s256`, callback
  `/auth/callback`.
- Mọi request ngoài loopback đều bị chặn; không gọi Google/Auth provider thật.

Lượt WebKit đầu tiên không hydrate vì `.env.local` khai báo site HTTPS trong khi
server local chỉ phục vụ HTTP. Đây là lỗi harness. Chạy lại với site URL local
HTTP đúng thì 6/6 mobile PASS. Spec cũng được siết để chỉ cho phép host loopback
và tiếp tục chặn mọi host ngoài máy.

### 3. Callback, membership và chống salon trùng

```sh
npm run test:unit -- \
  src/app/auth/callback/route.spec.ts \
  src/app/register/setup/page.spec.ts \
  src/shared/auth/__tests__/emailPasswordAuth.spec.ts
```

Kết quả: **39/39 PASS**.

```sh
npm run test:unit -- \
  src/shared/register/__tests__/completeSalonRegistrationAction.spec.ts \
  src/shared/security/__tests__/registrationSetupAuthorizationBoundary.spec.ts \
  src/app/choose-salon/page.spec.ts \
  src/app/register/registerOnboardingExperience.spec.ts
```

Kết quả: **30/30 PASS**.

Các điều kiện được chứng minh ở lớp contract/unit:

- Account mới không có membership đi tới `/register/setup`.
- Existing owner đi thẳng tới dashboard đúng role.
- Account nhiều salon đi tới `/choose-salon`.
- Callback thiếu PKCE fail-visible, không đặt session cookie.
- Salon đã setup trả mutation-free no-op, không tạo salon mới.
- Salon owner chưa setup chỉ hoàn tất qua RPC atomic.
- Race membership hoặc role sai fail closed, không rơi xuống nhánh tạo salon.

### 4. Build

`npm run build`: **PASS** — compile, TypeScript, 61/61 static pages và route
manifest hoàn tất. Build dùng provider kill switches; không deploy.

## Điều kiện còn thiếu để ký PASS QA end-to-end

1. Gắn Preview của đúng branch vào Supabase QA bằng biến branch-scoped; giữ mọi
   SMS/email/call/payment/provider ngoài Google Auth ở OFF.
2. Bật Google provider cho đúng QA bằng OAuth client thử nghiệm.
3. Thêm đúng Preview URL và `/auth/callback` vào redirect allow-list.
4. Redeploy Preview, đăng nhập bằng một Google QA account được cho phép.
5. Kiểm chứng new account, existing account và mở callback ở trình duyệt khác.
6. Xác nhận số membership/salon trước-sau và xóa dữ liệu synthetic.

Đây là thay đổi cấu hình hosted, provider OAuth và deploy Preview; phải có phê
duyệt hành động riêng trước khi thực hiện.

## Biên an toàn

Chưa commit, chưa push, chưa tạo PR mới, chưa deploy Preview/Production, chưa
thay đổi Supabase, chưa tạo user/salon/booking và chưa gửi thông báo. Không thay
đổi hai salon Live.
