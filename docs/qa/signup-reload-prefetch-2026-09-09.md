# Đăng ký — lỗi WebKit khi reload, 2026-09-09

Base: `72202972e4fd20e33aee562e9addefc36dc53b0a` (Production #1376).
Scope: lỗi còn mở từ ca đăng ký VI mobile trong main CI `34417958564`.
Status: PASS_LOCAL trong phạm vi bên dưới; chưa commit/push/CI/Preview/Production.

## Bằng chứng trước sửa

- Main CI: `auth-signup-confirmation.spec.ts`, VI mobile, lỗi `due to access control checks` trên homepage RSC request trong khoảng reload `/register/setup`; retry 1 PASS.
- Trace CI xác nhận request có `rsc: 1`, `next-router-prefetch: 1`. Diagnostic đặt pageerror giữa `reload:start` và `reload:end`.
- Trên production build của base trong môi trường loopback HTTPS + Auth/Mailpit local: 5 lần chạy không retry cho kết quả 4 PASS, 1 FAIL với cùng signature. Một lần kiểm tra tiếp trên build cũ lại FAIL với cùng signature.
- Các assertion xác nhận email, giữ phiên, tạo salon riêng tư trial 14 ngày và vào dashboard đi qua; assertion lỗi trình duyệt thất bại.

## Thay đổi

`RegisterStepShell` tắt prefetch riêng liên kết về `/` bằng `prefetch={false}`. Trang chủ được tải khi người dùng bấm liên kết; các luồng đang đăng ký không khởi chạy request tải trước không cần thiết dễ bị ngắt khi reload.

Giữ nguyên màu sắc, bố cục, text, cơ chế PKCE, Secure cookie, quyền salon, thời gian trial và provider. Không nới assertion pageerror, không thêm retry/chờ cố định, không đổi CORS hoặc cấu hình Auth.

Regression ghi nhận mọi homepage prefetch từ trang setup và yêu cầu không có request đó trong hành trình xác nhận/reload/tạo salon. Bổ sung điều hướng về trang chủ sau reload ở EN/VI, Chromium/WebKit.

Tài liệu API: [Next.js Link prefetch](https://nextjs.org/docs/app/api-reference/components/link#prefetch); đối chiếu thêm tài liệu đóng gói cùng Next.js 16.3.4 trong node_modules.

## Kiểm tra

- Sau sửa: VI mobile lặp 10 lần, 10 PASS, 0 FAIL/skip/flaky/retry.
- 29 unit regression PASS; build Webpack, typecheck, focused lint PASS.
- Signup confirmation hiện có: 8/8 PASS, Chromium/WebKit (EN/VI signup, resend sau 60 giây, link ở browser khác).
- Liên kết trang chủ sau reload: 4/4 PASS, EN/VI × Chromium/WebKit. Lần đầu bốn test mới chờ nhầm nút Sign up được bật khi form trống và FAIL; đã sửa test chờ `social-auth-controls[data-hydrated=true]` trước/sau reload. Không sửa hành vi nút đang đúng. Report lần đầu được giữ nguyên; kết quả cuối nhóm này ở `home-fixed.json`.
- Tương thích keyboard-submit và registration-copy: 40/40 PASS, 0 skip/flaky/retry.
- Tổng theo nhóm kiểm tra cuối: 52 browser cases PASS, cộng 10 lượt lặp VI mobile đã nêu. Đây là các ca theo project/browser, không phải số chức năng.
- Render EN/VI × desktop Chromium 1280px/mobile WebKit 320px: 4/4, không tràn ngang, không pageerror, nút Sign up cao 48px, cùng màu chữ/nền input và button. Đã xem ảnh VI mobile và EN desktop, không thấy chồng lấn ở hai ảnh này; không phải audit toàn bộ theme.
- DB local sau test: 0 Auth users, salons, salon_members, bookings, client_profiles; Mailpit 0 message. `cleanup-counts.json` xác nhận.
- Đã dừng server, đóng browser và huỷ database dùng một lần sau khi xác minh các số đếm bằng 0.
- Log local baseline/fixed không có `The destination stream closed early`, `TypeError`, warning persist-session hoặc `Error:` trong các lượt kiểm tra này.

## Giới hạn

Bằng chứng xác định trigger request tải trước/reload và chứng minh bản sửa loại bỏ trigger tại local. Chưa xác định sâu hành vi nội bộ engine WebKit/Next gây thông báo access-control; không kết luận sai cấu hình CORS. Chưa chứng minh lỗi này từng xảy ra cho khách thật hoặc đã hết trên Production. Không chứng nhận 784/784 chức năng.

Evidence: `/Users/huytran/nailiq-audit-results-20260907/signup-reload-prefetch/`.
