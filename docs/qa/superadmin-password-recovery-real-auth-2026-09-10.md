# SuperAdmin password recovery — bằng chứng Auth QA thật

**Mốc kiểm chứng trước khi mở PR: Local QA PASS. Kết quả CI/Preview được theo dõi riêng trong PR #1385.**

## Phạm vi

Bổ sung bằng chứng còn thiếu cho chức năng #51 trong danh sách 784: gửi yêu cầu từ form thật → email trong Mailpit local → GoTrue/PKCE → callback thật và cookie recovery → đổi mật khẩu qua server action thật → đăng nhập mới.

Base b56d623ac6650b3deb931468be08922b2b163ac6; nhánh test/superadmin-reset-real-auth-20260910. Không sửa mã ứng dụng, schema, quyền Production, CSS hoặc primitive. Ba file của lô: spec mới, cấu hình workflow Auth QA, báo cáo này.

## Kết quả

| Kiểm tra | Kết quả |
|---|---|
| Sáu vai trò × Chromium/WebKit: link hợp lệ, mật khẩu cũ bị từ chối, mật khẩu mới đăng nhập qua UI, cookie recovery bị xóa, link dùng lại bị từ chối | 12 PASS |
| Trình duyệt khác không có PKCE verifier | 2 PASS |
| Quyền bị thu hồi trước khi mở link | 2 PASS |
| Quyền bị thu hồi khi form đã mở | 2 PASS |
| Tổng spec mới | **18 PASS, 0 FAIL/SKIP/flaky/retry** |
| Hồi quy email callback + signup confirmation hiện có | **42 PASS, 0 FAIL/SKIP/flaky/retry** |

Sáu vai trò: founder, ops_admin, support_admin, billing_admin, ai_admin, readonly_analyst. Ca bị thu hồi quyền còn xác minh mật khẩu cũ vẫn đúng và mật khẩu mới không được lưu.

42 ca hiện có và phiên bản 8 ca đầu của spec mới chạy cùng một lượt 50 PASS. Sau đó mở rộng sáu vai trò và chạy lại spec mới: 18 PASS. Có **60 ca phân biệt**, không cộng 50+18 thành 68 ca mới. Các ca cũ đã qua cả đăng ký mới, email xác nhận, gửi lại email theo thời gian chờ thật và trình duyệt khác.

Build webpack đầy đủ, typecheck, lint spec và diff check PASS. YAML workflow parse PASS; đoạn Python cấu hình Auth được chạy trong thư mục tạm và sinh đúng cấu hình local dùng để kiểm thử. CI hosted chưa chạy.

## Hai lỗi trong lần viết kịch bản đầu

1. Kịch bản mong alert no-role sau khi thu hồi quyền. Thực tế sign-out làm server render lại và chuyển về forgot-password với notice invalid_or_expired. Đã sửa kỳ vọng để xác minh luồng chặn thực tế và kiểm tra mật khẩu không đổi.
2. Nhiều tài khoản thử dùng chung IP loopback đã chạm giới hạn Auth, trả thông báo Too many sign-in attempts. Mỗi browser QA nay có địa chỉ tài liệu IPv6 riêng qua proxy local. Giữ nguyên rate limiter, không xóa quota để khiến ca kiểm thử xanh.

Đây là sửa cách kiểm thử; chưa xác nhận lỗi sản phẩm mới cần sửa. Lịch sử 6 PASS/2 FAIL được giữ trong recovery-eight.json/log.

## Môi trường và dữ liệu

Supabase CLI 2.109.1 giống workflow; project local riêng nailiq-reset-real-auth-20260910. Dùng baseline và forward migrations đã có trong repo, đạt kiểm tra parity với bản chuẩn được lưu trong repo. Đây không phải lần truy vấn schema Production mới.

Auth và app chỉ trỏ loopback; demo tắt; SMS/calls tắt; không nạp khóa nhà cung cấp thật. HTTPS localhost:3443 giữ cookie Secure/HttpOnly; Mailpit bắt toàn bộ email QA, không gửi email ra bên ngoài. Trace/video tắt cho spec reset để không lưu mật khẩu hoặc bearer vào trace. Đã lưu 12 ảnh form trống và xem ảnh mobile founder: label/nút song ngữ, bố cục nằm trong viewport; tiêu đề/hướng dẫn vẫn tiếng Anh như hiện trạng.

Sau test: **0 auth users, 0 auth sessions, 0 superadmins, 0 salons, 0 bookings, 0 client profiles, 0 Mailpit messages**. Server app/TLS đã dừng. Stack riêng đã stop --no-backup; không còn container/volume mang project ID của lô này. Các volume của project khác được giữ nguyên.

## Thay đổi workflow

Spec chạy trong shard 5 mới, dùng Auth thật, canonical HTTPS local, redirect vào proxy TLS và khóa ký recovery ngẫu nhiên mỗi run. Shard 4 giữ nguyên môi trường HTTP, tắt demo và cấu hình email confirmation của main cho 196 ca hiện có. Không thay CSP, cookie Secure, mã ứng dụng, biến Vercel Production hoặc secret hosted.

Lượt CI cf4d70b6 xác nhận 18/18 ca recovery mới PASS, nhưng 77 ca mobile cũ FAIL vì dùng HTTP với CSP upgrade-insecure-requests của cấu hình HTTPS. Trace ghi nhận WebKit tải JavaScript tại https://localhost:3000 và lỗi TLS handshake. Tách recovery sang stack/build riêng giải quyết việc trộn hai origin; giữ toàn bộ 196 ca cũ và chính sách bảo mật ứng dụng.

Bộ lọc thư mục SuperAdmin của shard 1 dùng dấu gạch chéo cuối để không bắt nhầm spec recovery ở thư mục cha; đã tái hiện lỗi chọn nhầm bằng Playwright --list trước khi sửa. Discovery năm shard phải liệt kê 176/112/112/196/18 ca, với recovery chỉ nằm ở shard 5. Đây là kiểm tra chọn ca, không phải chạy lại các ca đó. Kết quả CI mới sau tách nhóm được theo dõi trong PR #1385.

## Giới hạn

Bằng chứng là Auth thật trên database QA dùng riêng, không phải đổi mật khẩu tài khoản khách/Production. Chưa kiểm chứng gửi email qua SMTP Production, thời gian hết hạn 15 phút trên đồng hồ thật, hay mọi sự cố mạng/nhà cung cấp. Chưa chứng nhận chức năng #51 hoàn thành 100% hoặc toàn bộ 784 chức năng. Không cập nhật tổng 784 bằng số test cases.

## Bằng chứng và nguồn

Artifact root: /Users/huytran/nailiq-audit-results-20260907/superadmin-reset-real-auth/

- recovery-final18.json/log, auth-regression.json/log, verified-tests.json.
- cleanup-receipt.json, stack-destroy.log, local-manifest.json.
- form-{chromium,mobile}-{role}.png, app-build.log, typecheck-final.log, lint-final.log.
- workflow-fixture-step.txt: đoạn cấu hình CI đã đối chiếu thực thi.
- [Supabase Auth updateUser](https://supabase.com/docs/reference/javascript/auth-updateuser) và [Auth changelog](https://supabase.com/changelog): tài liệu tham khảo đối chiếu SDK/Auth.
