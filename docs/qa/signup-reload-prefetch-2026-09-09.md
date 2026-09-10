# Đăng nhập/đăng ký — lỗi WebKit khi điều hướng, 2026-09-09

Base: `72202972e4fd20e33aee562e9addefc36dc53b0a` (Production #1376).
Scope: lỗi còn mở từ ca đăng ký VI mobile trong main CI `34417958564`.
Status: PASS_LOCAL cho bản bổ sung liên kết đăng nhập. CI/Preview của commit 90e3c6c9 chỉ kiểm chứng bản sửa liên kết trang chủ trước đó; không thay thế các gate cần chạy lại cho bản bổ sung.

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

## Bổ sung sau kiểm tra Preview #1377

- Preview 90e3c6c9: bốn lượt register/reload/Home PASS. Khi mở rộng sang login, WebKit ghi pageerror `.../register?_rsc=... due to access control checks.` trong chuỗi mở login, reload, chụp form và về Home. Không xác định chính xác bước gây ngắt request từ log đầu tiên này.
- Production 72202972: bốn lượt đọc-only tương ứng không có pageerror. Không kết luận lỗi đăng nhập là hồi quy của PR hoặc đã tái hiện cho khách thật.
- `LoginPageClient` còn hai vị trí Link đến `/register` (nhánh email và phone). Tắt prefetch cho cả hai; giữ nguyên explicit navigation, tất cả action/quyền/cookie và styling.
- Bốn test mobile trước sửa ghi nhận 2–4 request tải trước `/register` mỗi ca; assertion không có background signup request FAIL 4/4, không phải bốn lỗi nghiệp vụ hay bốn pageerror. Một thử nghiệm sau sửa ghi nhầm request hợp lệ từ landing page sau navigation; đã giới hạn quan sát trước thao tác rời login, không nới pageerror assertion.
- Regression mới: EN/VI × Home/Signup × Chromium/WebKit. Hiển thị link đăng ký, chụp form, xác nhận không tải trước signup khi còn ở login; bấm từng link, xác nhận trang đích và không pageerror.
- Final local: **60/60 browser cases PASS trong một run**, **20/20 lượt lặp mobile PASS**, **29/29 unit PASS**, 0 fail/skip/flaky/retry. Build Webpack, sequential typecheck, focused lint, schema parity và diff check PASS.
- Render login EN/VI × desktop Chromium 1280px/mobile WebKit 320px: 4/4, không pageerror/tràn ngang, nút Sign in 48px, màu input/button nhất quán. Đã xem ảnh VI mobile.
- Cleanup: 0 Auth users/salons/memberships/bookings/client_profiles/Mailpit messages. Bằng chứng mới: `acceptance-v2.json`, `login-full-final.json`, `login-repeat-final.json`, `login-cleanup-counts.json`, `login-render.json` và các log `login-*`.
- Rà React/TypeScript: chỉ thay props Link; không thêm hooks, listener hoặc logic data trong application code. Listener mới chỉ ở E2E; không có quyền hoặc query mới.
