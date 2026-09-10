# MFA — khôi phục khi không đọc được trạng thái 2FA

Ngày: 2026-09-10. Base: `04b21fd799a1f5e8ce317547f72b4e810620ddf1`.
Nhánh: `fix/mfa-status-read-recovery-20260910`. Mục kiểm kê: **50 — MFA cho SuperAdmin**.

## Lỗi tái hiện

Mức độ: trung bình — thông tin trạng thái bảo mật chưa được xác minh nhưng giao diện vẫn cho bắt đầu cấu hình.

1. Mở phần quản lý MFA trong khi request đọc trạng thái còn chờ. `enrolled` là `null`, nhưng điều kiện `!enrolled` vẫn hiện Enable 2FA.
2. Cho request trả `{ok:false,error:"load_failed"}`: không có lỗi hiển thị hoặc nút thử lại; Enable 2FA vẫn hiện sau khi pending kết thúc.
3. Trong server action thật, giả lập `listFactors()` trả `{data:null,error}`: action bỏ qua error và trả thành công với `enrolled:false`. Rejected promise từ Auth/session cũng không được xử lý.

Bằng chứng trước sửa: **3 browser FAIL** (tải chậm ON/OFF và returned error), **4 unit FAIL / 3 PASS**. Test dùng build từ code base ở trên. Không gây lỗi hoặc thao tác trên tài khoản Production.

## Bản sửa

- `getMfaStatus` trả `load_failed` khi Auth lỗi, thiếu data hoặc promise bị reject. Giữ kiểm tra active SuperAdmin session; chỉ trả OFF sau lần đọc thành công.
- `MfaManager` phân biệt đang tải, không xác định, ON và OFF; không hiện thao tác bật/tắt trước khi có kết quả xác nhận.
- Lỗi đọc được hiển thị trong `role="alert"`, có nút Try again dùng Button có sẵn. Lỗi mất quyền có thông báo đăng nhập lại. Retry không gửi trùng khi đang chờ.
- Chỉ dùng token màu hiện có; không sửa chính sách MFA hoặc quyền truy cập.
- Thêm fixture độc lập và job CI; thay thế module action bằng stub, chỉ cho phép action đọc trạng thái, chặn các action thay đổi MFA và mọi request ra ngoài.

## Passed — cục bộ

- **18/18 browser PASS**, 0 SKIP, 0 retry: 6 kịch bản × Chromium desktop / Chromium 320px / iPhone WebKit. Bao gồm tải chậm, abort, HTTP 503, typed error, unauthorized, retry bàn phím, thành công ON/OFF, không tràn ngang và không lỗi JavaScript.
- **242/242 unit regression PASS**, 30 file Auth/SuperAdmin; gồm 7 ca của server action mới.
- Build fixture và build toàn ứng dụng (Webpack): PASS. Typecheck chạy sau build: PASS.
- Lint toàn repo: 0 lỗi, 41 cảnh báo hiện có; lint file chạm: 0 lỗi/cảnh báo. CI YAML parse: PASS.
- Đã xem trực tiếp ảnh lỗi ở 320px: nội dung và nút đầy đủ, không bị cắt, trạng thái Unavailable khác ON/OFF.

## Chưa chứng minh

- CI/Preview của bản sửa mới chưa chạy; chưa commit/push/deploy.
- Đây là kiểm thử phản hồi UI với action stub và server contract với Auth stub. Không chứng minh TOTP thật, enroll/verify/unenroll, toàn bộ vai trò hay hành vi Production.
- Shell hiện có nhánh cho qua khi kiểm tra assurance level phát sinh lỗi; chưa tái hiện runtime nhánh này trong đợt đọc trạng thái, cần kiểm tra riêng trước khi kết luận hoặc thay đổi chính sách. Các mutation MFA cũng chưa được kiểm tra mất response ở đây.
- Không cập nhật số tổng 784 hoặc chứng nhận mục 50 hoàn thành 100%.

Bằng chứng: `/Users/huytran/nailiq-audit-results-20260907/mfa-status-recovery/` — baseline/final browser JSON, unit logs, build/typecheck/lint logs và ảnh chụp. Hợp đồng SDK đã đối chiếu với bản cài đặt `@supabase/auth-js` và [tài liệu listFactors](https://supabase.com/docs/reference/javascript/auth-mfa-listfactors).
