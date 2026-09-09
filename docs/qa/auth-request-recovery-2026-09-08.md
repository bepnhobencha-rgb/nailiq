# Auth — giữ form khi yêu cầu bị chặn hoặc mất phản hồi

Phạm vi: Master Plan giai đoạn 1, đăng ký/đăng nhập email. Base `f784855f6e770f63e0ecd62c68e57d7b931ed3ea`. Nhánh `fix/auth-throttle-recovery-20260908`.

## Lỗi và nguyên nhân

- **P1 / tái hiện:** POST đăng ký nhận HTTP 429 dạng `text/plain; charset=utf-8` làm mất form và hiện “Something went wrong on our side”. Cùng chữ ký trên Chromium và WebKit của build main sạch, 0/2 ca đạt trước sửa.
- Next 16.3.4 từ chối phản hồi Server Action không phải Flight. Với Content-Type có charset, lỗi đến client chỉ còn thông báo chung; không được suy đoán mọi lỗi mạng là hết quota.
- Ba handler email trong `SocialAuthButtons` chưa bắt promise rejection. Lỗi thoát khỏi `startTransition` và thay toàn bộ trang bằng error boundary.
- Kết quả typed `rate_limited` hoặc `server_error` khi đăng nhập bị nhánh `kind === signin` đổi thành thông báo sai email/mật khẩu.

## Bản sửa

- Bắt lỗi quanh lời gọi action, giữ email/mật khẩu hoặc màn hình chờ xác nhận, bỏ trạng thái pending và cho phép thử lại thủ công.
- EN/VI thông báo chưa xác nhận được kết quả; không khẳng định yêu cầu chưa được xử lý, không tự gửi lại, không hiển thị nội dung lỗi kỹ thuật.
- Typed `rate_limited` hiển thị hướng dẫn chờ; `server_error` hiển thị trạng thái chưa xác nhận. Lỗi sai thông tin đăng nhập vẫn có thông báo riêng.
- Dùng alert và màu có sẵn. Không đổi proxy, quota, quyền, schema, server action, cookie, provider hay thời gian chờ gửi lại 60 giây.

## Kiểm tra

- Bộ browser mới: 4 thao tác × EN/VI × Chromium/WebKit. Chặn 429, 503, lỗi mạng; thêm typed limit/server error cho các action dùng contract này; giữ draft, không tự retry, thử lại thủ công, không tràn ngang/pageerror, contrast alert.
- Các auth POST được chặn tại browser và trả Flight giả lập cho kết quả thành công/typed error. Đây là kiểm tra ranh giới giao diện, không phải kiểm tra Auth/SMTP thật; luồng Auth thật đã có `auth-signup-confirmation.spec.ts` cùng shard CI.
- Gắn spec mới vào shard real-auth của CI, chạy cả hai trình duyệt.
- Nghiệm thu local: 24/24 browser PASS (16 mới + 8 cũ), 0 skip/failure/flaky/retry; unit 4.532 PASS / 1 skip; build/typecheck PASS; lint 0 lỗi / 1 cảnh báo cũ. Chi tiết trong báo cáo ngoài repo: `/Users/huytran/nailiq-audit-results-20260907/auth-throttle-recovery/REPORT.md`.

## Giới hạn

Chưa commit/push, chưa CI/Preview/Production cho lô này. Không gửi email/SMS/call, không tạo tài khoản/salon/booking thật. Không kết luận đủ 784 chức năng. Chưa mở rộng xử lý promise rejection của Google OAuth.
