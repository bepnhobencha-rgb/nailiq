# Google Auth initialization recovery — 08/09/2026

Trạng thái: **PASS_LOCAL**. Nhánh `fix/google-auth-recovery-20260908`, nền `00333bd2c6d0da4e3426edcf1f2da466758867ac`. Chưa commit/push, chưa CI/Preview/Production cho lô mới.

## P1 — lỗi khởi tạo Google làm mất form

Đã tái hiện bằng lỗi giả lập có kiểm soát trong WebCrypto, qua SDK Supabase thật đang cài: mở đăng ký → nhập email/mật khẩu giả → cho `crypto.subtle.digest` từ chối việc tạo PKCE → bấm Google. Trên mã nền, cả Chromium và WebKit đều thay form bằng màn hình lỗi chung. Người dùng phải tải lại và mất dữ liệu đang nhập. Hai ca hồi quy trước sửa đều FAIL đúng ở điều kiện giữ form.

Nguyên nhân: exception từ khởi tạo client/chuẩn bị PKCE thoát khỏi `startTransition` và đi vào error boundary. Handler trước đó chỉ xử lý kết quả có trường `error`.

Bản sửa bắt exception tại handler, hiện thông báo Google thất bại EN/VI có sẵn, giữ email/mật khẩu và mở lại nút. Chỉ người dùng bấm lại mới thử lại. Không đổi SDK, callback URL, PKCE, cookie, quyền, schema, provider, màu hoặc layout.

## Kiểm chứng cuối

- 12/12 ca Google PASS trên Chromium/WebKit: login/register × EN/VI giữ form khi lỗi, sau đó tắt fault và thử lại; cộng bốn ca in-app browser giữ Google disabled và email signup khả dụng.
- Mỗi lần thử lại tạo đúng một OAuth handoff được chặn tại browser; provider `google`, PKCE `s256`, challenge 43 ký tự và callback đúng đường dẫn. Không chuyển đến Google/Auth thật.
- 12/12 ca hồi quy signup/signin/magic-link bị 429/503/mất phản hồi PASS. Không chạy lại bốn ca resend có cooldown trong lô này.
- Tổng 24 ca browser riêng biệt PASS, không skip/retry/flaky; không top-level runner error.
- Full unit: 4.532 PASS, 1 SKIP.
- Build production bằng Webpack, typecheck, lint file sửa, YAML/workflow selection và diff check PASS. Lint còn một cảnh báo điều hướng Next.js có sẵn tại handler đăng nhập bằng mật khẩu.
- Spec mới được chọn trong shard real-auth hiện có của CI; chưa thực thi CI.
- Đã xem ảnh đăng ký EN desktop và VI mobile sau lỗi: thông báo rõ, form còn nguyên, không chồng/tràn ngang trong phạm vi ảnh. Test kiểm tra không tràn ngang cho cả tám ca recovery.

## Giới hạn và lịch sử test

Đây là lỗi điều kiện đã tái hiện bằng fault injection; chưa chứng minh lỗi WebCrypto này đã xảy ra tự nhiên trên Production. Google OAuth thật, provider availability/consent và phiên đăng nhập sau callback không được kiểm chứng bởi phép thử handoff bị chặn này. Hai timeout context cũ và các lỗi stream thiếu request/stack vẫn NOT_PROVEN.

Các lỗi môi trường được giữ riêng: Turbopack từ chối symlink dependencies (đã dùng Webpack cho build local); một lượt browser chạy trước khi server sẵn sàng (đã xác minh HTTP 200 trước lượt cuối); unit ban đầu dùng nhầm biến cấu hình app (đã chạy lại toàn suite trong môi trường unit sạch, không thay test để làm xanh).

Không tạo database/user/salon/booking, không gửi email/SMS/call thật. Server local đã dừng. Các browser writes và OAuth handoff đều bị chặn/giả lập, provider secrets không được nạp.

Bằng chứng: thư mục `nailiq-audit-results-20260907/google-auth-recovery`, gồm `browser-before.json`, `before-results`, `google-final.json`, `google-final-results`, `compatibility.json`, `unit-final.json`, build/typecheck/lint logs và `acceptance.json`. Không cộng 24 ca test thành số chức năng trong danh mục 784.
