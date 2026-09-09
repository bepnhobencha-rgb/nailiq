# Gửi form xác thực bằng bàn phím — 2026-09-09

## Phạm vi và lỗi

Base Production/main `9bcacdff044c8a3d58414439ad5837ac52ed7b3a`; worktree `/Users/huytran/nailiq-auth-keyboard-submit-20260909`. Phạm vi giai đoạn 1 Master Plan, liên quan mục kiểm kê #23 đăng ký và #37 đăng nhập; không thêm chức năng ngoài luồng xác thực hiện có.

**P2 — thao tác bàn phím không gửi form.** Trên `/login`, nhập email và mật khẩu rồi nhấn Enter không có tác dụng. Bấm nút Sign in vẫn khởi chạy action, nên đây không phải mất khả năng đăng nhập hoàn toàn.

Tái hiện trong Chromium mới trên Production đúng SHA: sau khi tải/hydrate trang, chặn toàn bộ network; nhập dữ liệu tổng hợp, Enter ghi 0 request, click Sign in ghi 1 POST đã bị abort tại trình duyệt. Không có request xác thực/provider thật được gửi. Code xác nhận email/password nằm ngoài form và các nút password đều `type="button"`; form magic-link cũ chỉ bao quanh nút, không chứa email.

Regression mới chạy trên production build local trước sửa cũng RED: chờ 1 action request nhưng nhận 0. Log/JSON/screenshot/trace được giữ trong thư mục bằng chứng, không bị ghi đè bởi lượt PASS.

## Bản sửa

- Một form chung chứa các trường email/password; Enter gửi primary action theo mode: login → signin, register → signup.
- Primary button dùng submit, không giữ onClick trùng; secondary password action và forgot-password dùng button riêng.
- Magic-link mode dùng submit của form chung; không còn form lồng.
- Giữ nguyên validation ứng dụng EN/VI bằng `noValidate`, guard hydration/pending và giới hạn độ mạnh riêng signup. Signin vẫn cho gửi mật khẩu ngắn như trước.
- Không đổi action server, quyền, rate limit, chính sách mật khẩu, thông báo hoặc kiểu dáng.
- Thêm file regression vào shard real-auth của workflow E2E để CI chạy trước merge.

## Kiểm chứng local

| Kiểm tra | Kết quả |
|---|---|
| Regression bàn phím, 8 ca × EN/VI × Chromium/WebKit | **32 PASS, 0 skip/fail/flaky, 0 retry** |
| Recovery cũ cho signup/signin/magic-link và Google | **24 PASS, 0 skip/fail/flaky, 0 retry** |
| Unit signup confirmation và auth rate-limit boundary | **11 PASS** |
| Production build Webpack, rồi typecheck tuần tự | **PASS** |
| ESLint hai file TS/TSX thay đổi | 0 lỗi; 1 cảnh báo có sẵn tại `window.location.assign` giữ cookie sau auth |
| `git diff --check` | **PASS** |
| Review độc lập về hành vi, policy và safety | **PASS**, không finding cần sửa |

Browser tests chặn mọi action POST, dùng response lỗi giả lập để kiểm tra đúng payload/action, giữ draft và manual retry. Lượt recovery loại resend vì màn hình confirmation/resend không bị sửa. Hai caller public đang mở password mode được kiểm tra trực tiếp; compact SMS fallback và IME/bàn phím iPhone vật lý chưa chạy riêng.

Môi trường local chỉ dùng URL loopback và key tổng hợp; không có credential Production, không khởi động DB, không gửi SMS/email/payment/provider. Ảnh register 390×844 đã xem, không thấy vỡ layout; đây không phải audit mọi màu sắc/toàn bộ giao diện. Browser và app do lượt này khởi động được đóng sau kiểm thử.

## Bằng chứng và giới hạn phát hành

Thư mục `/Users/huytran/nailiq-audit-results-20260907/auth-keyboard-submit/`: `red.log`, `red-results.json`, `red-artifacts/`, `keyboard.log`, `results.json`, `recovery.log`, `recovery-results.json`, `unit.log`, `build.log`, `typecheck.log`, `register-mobile.png` và runner/config local.

Tại thời điểm chốt local: chưa commit/push/PR hoặc triển khai bản sửa bàn phím. Tests chứng minh browser phát action đúng và hồi phục lỗi, không chứng minh tài khoản/provider thật đăng nhập thành công. Lỗi 503 booking nhóm lịch sử vẫn chưa rõ nguyên nhân; lần quét tiếp 21:50:18–21:51:50 UTC không có 5xx mới. Không suy ra 784/784 chức năng đã hoàn thành.
