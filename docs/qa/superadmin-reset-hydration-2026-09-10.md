# SuperAdmin reset password — hydration input loss

## Phát hiện và phạm vi

Base: `43228ed6b97aa2e062fb7b5e8666f8638970fb9d` (PR #1383). Mức độ: trung bình, người dùng nhập nhanh lúc trang đang khởi tạo có thể phải nhập lại mật khẩu. Chưa xác nhận tần suất hoặc sự cố trên tài khoản Production.

CI main 34456882757, attempt 1: form mật khẩu 59 PASS, 1 FAIL. Ca WebKit “pending request blocks repeated submission” thất bại tại assertion nút disabled. Artifact 10143970592 cho thấy ô đầu trống, ô xác nhận có nội dung và lỗi “Passwords don't match”. Attempt 2 trên cùng SHA: 60 PASS. Lần lỗi đầu vẫn được giữ; không tuyên bố CI đạt ngay lần đầu.

Tái hiện local bằng component thật và action giả lập: giữ các script chưa tải, nhập ô đầu, cho script tải/hydrate, nhập ô xác nhận. Nội dung ô đầu biến mất, báo mismatch, không có request mutation. Probe ghi DOM length 19 nhưng React state length 0 sau hydration; cập nhật ô xác nhận làm ô đầu trở lại length 0. Các trường hợp chạy bình thường lặp 30 lần đều PASS. Đây là bằng chứng nguyên nhân của trường hợp tải JavaScript chậm, khớp biểu hiện CI; CI lần đầu không có trace để khẳng định chính xác thời điểm hydrate.

Mã form và fixture không bị thay đổi trong PR booking #1383. Không rollback bản booking chỉ dựa vào lỗi có sẵn này.

## Sửa

- Dùng `useSyncExternalStore` theo pattern Auth có sẵn để giữ SSR/first hydration giống nhau.
- Hai input và nút submit bị disabled cho tới khi React gắn handler. Form hiển thị nguyên bố cục.
- Giữ validation, pending request, server action, quyền và thông báo hiện có.
- Thêm test giữ script để kiểm tra trạng thái trước/sau hydration và bảo toàn hai mật khẩu sau transport failure; mọi mutation đều bị chặn và giả lập ở loopback.
- JSON/trace của fixture được lưu dưới `test-results/password-reset-form/` để uploader CI hiện tại thu thập được; trace chỉ giữ khi thất bại.

## Xác minh local

- Test mới trước sửa: 2 FAIL (Chromium/WebKit), do input vẫn enabled trong SSR.
- Sau sửa: 62 PASS, 0 SKIP/FAIL/flaky/retry; gồm 60 ca cũ và 2 ca trì hoãn script.
- Build fixture và build toàn ứng dụng (`next build --webpack`): PASS.
- `npm run typecheck`: PASS.
- ESLint 3 file thay đổi: PASS, không cảnh báo/lỗi.
- `git diff --check`: PASS.

Evidence tại `/Users/huytran/nailiq-audit-results-20260907/booking-error-recovery/`: `password-reset-first-*`, `password-reset-hydration-probe.json`, `password-reset-repeat30.json`, `reset-hydration-red.*`, `reset-hydration-fixed62.*`, `reset-hydration-app-build.log`, `reset-hydration-typecheck.log`, `reset-hydration-lint.log`.

## Trạng thái

Checkpoint trước xuất bản: local PASS trên nhánh `fix/superadmin-reset-hydration-20260910`. Người dùng đã duyệt commit/push và mở PR để chạy CI/Preview. Kết quả CI/Preview được ghi trong PR sau khi chạy trên commit xuất bản; kết quả CI của #1383 không chứng nhận patch mới. Chưa duyệt merge hoặc phát hành Production cho lô sửa này.
