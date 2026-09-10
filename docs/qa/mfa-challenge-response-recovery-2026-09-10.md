# Mục 50 — Khôi phục form nhập mã MFA khi lỗi phản hồi

Ngày: 2026-09-10. Base main: `24893a530da6dac9c09937c120e00f8b3944afd1`.
Nhánh cục bộ: `fix/mfa-challenge-response-recovery-20260910`.

## Lỗi đã tái hiện

- Trên Chromium, abort request `verifyMfaChallenge` khiến form thật rơi vào error boundary (`Unhandled fixture error`), mất chỗ nhập mã. Baseline browser: 2 ca FAIL (abort và trạng thái input khi đang chờ).
- Server action gộp lỗi dịch vụ vào `invalid_code`, không chứa rejected promise và có thể trả thành công khi SDK không có data/error. Baseline unit: 16 FAIL, 7 PASS.
- Phạm vi là phục hồi luồng đăng nhập MFA hiện có, thuộc kiểm tra đăng nhập và phản hồi rõ ràng của Master Plan. Không mở rộng chính sách MFA.

## Bản sửa

- Form bắt lỗi phản hồi, giữ mã khi chưa xác nhận được kết quả, hiện thông báo chung và cho phép thử lại thủ công. Không tự retry hay chuyển trang khi kết quả chưa rõ.
- Chặn submit trùng/thiếu sáu chữ số; khóa input khi đang chờ. Mã sai được xóa để nhập lại. Phiên hết hạn có liên kết đăng nhập lại.
- Server giữ kiểm tra phiên SuperAdmin đang hoạt động, phân biệt Auth tạm không khả dụng với mất quyền. Chỉ mã sai/challenge hết hạn đã được SDK xác nhận mới mang nhãn `invalid_code`; lỗi mạng, 503, 429, thiếu data được trả `verification_unavailable`. Factor vẫn chọn ở server.
- Nút dùng primitive `Button` và màu có sẵn. Bổ sung label cho ô nhập và liên kết mô tả lỗi. Không thêm màu hay primitive mới.
- Mở rộng fixture MFA hiện có; JSON report được ghi đúng thư mục upload của CI.

## Passed — cục bộ

- 45/45 browser PASS, không SKIP/retry: 27 ca nhập mã mới + 18 ca đọc trạng thái. Chromium desktop, Chromium 320px, iPhone WebKit.
- Bao phủ abort, HTTP 503, mất response sau khi stub hoàn tất, server throw, typed unavailable, mã sai, hết phiên, gửi trùng khi pending và input chưa đủ. Retry bằng bàn phím đi tới đích QA. Không lỗi JavaScript trong các ca phục hồi lỗi phản hồi.
- 265/265 unit Auth/SuperAdmin PASS, 31 file, gồm 23 ca server challenge mới.
- Build fixture và build toàn ứng dụng Webpack PASS. Typecheck chạy sau build PASS. Lint file chạm: 0 lỗi/cảnh báo; lint toàn repo: 0 lỗi, 41 cảnh báo hiện có. CI YAML parse PASS.
- Đã xem trực tiếp screenshot 320px: form, mã, thông báo và nút đều đầy đủ; không tràn ngang trong các ca lỗi phản hồi.
- Rà soát lần hai: thay đổi nằm trong form/challenge action và QA liên quan; active-session/role gate được giữ; không tự gọi lại mutation. Không sửa shell assurance gate, enroll/unenroll, schema hay cấu hình provider.

## Failed / Blocked

Các lỗi baseline trên đã qua lại sau sửa. Không còn lỗi tái hiện trong bộ kiểm tra đã chạy. Không có blocker kỹ thuật cục bộ.

## Not proven

Chưa commit/push, chưa chạy CI/Preview hoặc phát hành bản sửa này. Manifest bằng chứng cuối được lưu trong checkpoint kèm theo.

Browser dùng component thật nhưng thay toàn bộ MFA actions bằng stub cục bộ; unit dùng Auth client stub. Mọi request ngoài origin và action không đúng allowlist đều bị chặn. Không dùng tài khoản, TOTP secret, database, email/SMS hay dữ liệu salon thật. Các route đích QA không chứng minh quyền truy cập app thật.

Chưa chứng minh TOTP lifecycle thật, cookie AAL2 sau mất phản hồi, mọi vai trò hay Production. Nhánh shell cho qua khi đọc assurance level gặp lỗi vẫn là mục kiểm tra riêng đã ghi từ PR #1386; không thay đổi chính sách trong bản sửa này. Mục 50 và tổng 784 chưa được đánh dấu hoàn thành 100%.

Hợp đồng SDK đã đối chiếu với bản cài đặt `@supabase/auth-js` và [Supabase MFA verify](https://supabase.com/docs/reference/javascript/auth-mfa-verify); cách trả lỗi có kiểm soát đối chiếu tài liệu Next.js cài cùng repo.

Bằng chứng: `/Users/huytran/nailiq-audit-results-20260907/mfa-challenge-recovery/` — baseline/fixed browser JSON, log unit/regression, build, typecheck, lint, ảnh và checkpoint.
