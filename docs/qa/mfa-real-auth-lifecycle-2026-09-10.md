# MFA với Auth thật — 2026-09-10

Base: `043c2de0afc63f6f00fb0de2681323e4c01d59ec` (main sau PR #1388).
Phạm vi: mục 50 của danh sách 784; TOTP SuperAdmin. Kiểm tra local, chưa phát hành.

## Lỗi đã tái hiện và bản sửa

**MFA-REAL-01 — Đăng ký dang dở không được dọn (mức trung bình).**
Đăng nhập Founder/Ops Admin, mở Security, Enable 2FA, Cancel, Enable 2FA lần nữa.
Auth thật giữ hai yếu tố `unverified`. Tái hiện trên Chromium và WebKit iPhone.
Lặp lại có thể tiêu hết giới hạn yếu tố của tài khoản (stack QA cấu hình tối đa 10).

Nguyên nhân: SDK `@supabase/auth-js` hiện tại chỉ đưa yếu tố **verified** vào
`listFactors().data.totp`; yếu tố chưa xác minh nằm trong `data.all`.
Code dọn dẹp lặp qua `totp`, nên không nhìn thấy đăng ký dang dở. Mock cũ đưa
`unverified` vào `totp` trái hợp đồng SDK và che lỗi này.

Bản sửa đọc `all` và chỉ gỡ `factor_type=totp`, `status=unverified`.
Giữ nguyên yếu tố verified và yếu tố thuộc loại khác; vẫn dừng nếu dọn thất bại.
Không đổi chính sách MFA opt-in, cổng shell, quyền vai trò hay schema.

## Bộ kiểm tra

`e2e/superadmin-mfa-real-auth.spec.ts`: 10 kịch bản × Chromium/WebKit = 20 ca.
Dùng ứng dụng build thật, Server Actions thật, Supabase GoTrue và Postgres local.
Không thay Server Actions, không giả trạng thái yếu tố hoặc phản hồi Auth.

- Founder/Ops Admin: bật, QR hiển thị, lấy khóa thủ công, mã sai bị từ chối,
  mã TOTP đúng được chấp nhận, trạng thái verified, session AAL2, mở lại Security,
  đăng nhập mới qua cổng MFA, mã sai/đúng, tắt và đăng nhập lại không bị yêu cầu mã.
- Bốn vai trò còn lại: trang Security từ chối theo quyền hiện hành và không tạo yếu tố.
- Cancel rồi bật lại: chỉ còn một yếu tố unverified mới; mã đúng xác minh thành công.
- Mất phản hồi sau start/verify/unenroll thật: đọc lại trạng thái, không tự lặp
  mutation. Transport có cookie jar riêng để mất cả Set-Cookie. Với verify,
  xác nhận browser cũ vẫn AAL1; đăng nhập mới bị yêu cầu mã và nâng lên AAL2.
- Start bị mất phản hồi rồi người dùng bấm lại: yếu tố cũ được dọn trước khi tạo khóa mới.
- Kiểm tra không tràn ngang, lỗi JavaScript, write ngoài danh sách và cleanup từng tài khoản.

Mã TOTP QA dùng RFC 6238 SHA-1; 6 vector tham chiếu kiểm tra helper độc lập.
Auth local được bật TOTP tường minh; demo, SMS và cuộc gọi đều tắt, không có khóa
provider thật. Chỉ tạo tài khoản `e2e-superadmin-…@nailiq.test.invalid` dùng một lần.
Không dùng tài khoản, salon hoặc Auth Production.

CI nối vào shard HTTPS hiện có, cùng cơ chế guard, sweep và phá hủy database.
MFA TOTP chỉ bật trong cấu hình stack dùng một lần của shard này.
Trace/video/ảnh tự động tắt. Ảnh form che QR, khóa và input; sau mỗi ca xóa trang
khỏi browser để snapshot lỗi không chứa bí mật QA. Tài khoản bị xóa và kiểm tra 404.
Các trang cũ được giữ mở khi mở Security hoặc đăng nhập mới, theo cách kiểm tra quyền
SuperAdmin hiện có, tránh hủy các prefetch đang chạy gây nhiễu WebKit.

## Phát hiện cần giữ riêng

**AUTH-COOKIE-01 — Cookie phiên thiếu Secure trên HTTPS (chưa sửa trong lô này).**
Trên build production local, `NEXT_PUBLIC_SITE_URL=https://localhost:3443`,
đăng nhập mật khẩu SuperAdmin tạo `sb-127-auth-token` với `secure=false` ở cả
Chromium và WebKit. Kiểm tra Secure ban đầu FAIL. Nguồn ghi cookie chung
`src/shared/lib/supabase/server.ts` dùng tùy chọn mặc định SDK, không gắn Secure;
callback email có xử lý Secure riêng. Đây là vấn đề lớp cookie dùng chung cần lô
kiểm tra/sửa riêng cho cả luồng salon trước khi phát hành. Chưa đo cookie Auth
Production bằng tài khoản thật; không khẳng định có sự cố khách hàng.
Không coi việc bỏ assertion Secure khỏi ma trận TOTP là đã sửa lỗi cookie.
Thuộc tính cookie vẫn được ghi riêng vào bằng chứng của từng phiên.

**Phiên cũ sau mất phản hồi verify:** cookie browser vẫn AAL1 và danh sách yếu tố
trong session cũ chưa cập nhật; reload có thể tiếp tục ở Security. Cổng shell
hiện dùng mức assurance từ session và chính sách SOFT/fail-open. Đăng nhập mới
thực sự yêu cầu mã. Không thay chính sách cổng trong lô này; không tuyên bố mọi
phiên đang mở bắt buộc nâng AAL ngay sau khi tài khoản bật MFA.

**Nhiễu QA đã xác định:** transport WebKit không mang cookie khi chỉ sao chép
request headers, dẫn tới 307 trước mutation. Cookie jar riêng sao chép trạng thái
ban đầu xử lý đúng và vẫn không nhận cookie trả về vào browser. Goto quá nhanh
hủy prefetch WebKit; giữ trang đăng nhập mở giải quyết nhiễu này. Không sửa hoặc
nuốt lỗi ứng dụng để che các vấn đề fixture.

## Giới hạn và kết quả

Kết quả cuối local: **20/20 ca Auth thật PASS**, không retry/skip/flaky trong lượt
chạy cuối; **315/315 test Auth/SuperAdmin và vector TOTP PASS** (33 file).
Build Webpack, TypeScript, ESLint các file sửa và kiểm tra cấu hình shard CI đều PASS.
Đã xem ảnh Chrome OFF và phần đầu form Safari (bí mật được che); không có tràn
ngang trong 20 ca. Các input/nút được thao tác thật trong luồng test.
Cleanup xác nhận **0 Auth user, 0 MFA factor, 0 SuperAdmin** trong stack QA.

Giữ đầy đủ các lượt đỏ: main ban đầu có 2 lỗi cleanup thực trên 2 browser và
3 lỗi transport của fixture WebKit. Lượt đầu trên build sửa có 5 lỗi do điều hướng
QA hủy prefetch; mọi thao tác nghiệp vụ đã hoàn tất trước assertion lỗi browser.
Sau khi giữ trang cũ mở ở mọi bước điều hướng, lượt cuối 20/20 PASS.
Không xóa bằng chứng đỏ và không báo toàn bộ quá trình đạt ngay lần chạy đầu.
Không quy đổi 20 ca test thành 20 chức năng hoàn thành. Mục 50 và tổng 784 chưa
được nâng lên 100%. QR chỉ được xác minh hiển thị; chưa quét bằng ứng dụng
Authenticator trên điện thoại thật. CI/Preview/Production của lô mới chưa chạy.
