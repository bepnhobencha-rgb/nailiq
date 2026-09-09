# NailIQ — Quên mật khẩu: giữ form khi yêu cầu bị gián đoạn

Ngày: 2026-09-09. Trạng thái: **PASS_LOCAL**. Chưa commit/push, CI/Preview hoặc Production cho lô mới.

Nhánh `fix/forgot-password-request-recovery-20260909`, nền `de51d1b188fd4afc5463de6a9c4c6aab78907bcf` (PR #1365 đã phát hành). Phạm vi Master Plan giai đoạn 1: người dùng lấy lại quyền đăng nhập qua email; lỗi form khi request thất bại.

## Lỗi đã tái hiện và sửa

**P1 có điều kiện — request Quên mật khẩu bị chặn làm mất form.** Trên bản nền: mở `/login/forgot-password`, nhập email giả, chặn Server Action POST với HTTP 429. Chromium và WebKit đều thay toàn bộ form bằng màn hình “Something went wrong on our side”; 2/2 ca trước sửa FAIL tại điều kiện giữ form. Trace và snapshot tại `before-results/`, kết quả `browser-before.json`.

Nguyên nhân: promise của Server Action reject ở phía browser (proxy 429/503 hoặc mất phản hồi), thoát khỏi `startTransition` vì handler không có catch. Server action chỉ có thể trả kết quả có cấu trúc nếu request đến được và phản hồi về được browser.

Bản sửa bắt lỗi vận chuyển tại `ForgotPasswordClient`, giữ email, hiển thị `authRequestUnconfirmed` EN/VI có sẵn, mở lại nút. Không tự gửi lại hoặc tuyên bố đã gửi email khi chưa có xác nhận. Sửa email sẽ xóa lỗi; lần bấm tiếp theo được xử lý bình thường. Nhánh lỗi `server_error` có cấu trúc giữ thông báo cũ.

## Kiểm chứng

| Kiểm tra | Kết quả |
| --- | --- |
| Mới: 429, 503, abort, typed server error × EN/VI × Chromium/WebKit | 16 PASS, 0 skip/retry/flaky |
| Giữ email, không hiện màn hình đã gửi, không tự replay, sửa email xóa lỗi, user retry → nhận `{ok:true}` → màn hình xác nhận | PASS trong từng ca mới |
| Hồi quy signup/signin/magic request failure | 12 PASS |
| Hồi quy Google init failure/retry và in-app guard | 12 PASS |
| Tổng browser riêng biệt của lô này | 40 PASS, 0 retry/flaky/runner error |
| Toàn bộ unit | 4.532 PASS, 1 SKIP, 0 FAIL |
| Build production Webpack, typecheck tuần tự sau build, lint file sửa, diff check | PASS |

Full unit bao gồm 27 ca liên quan password reset: actions 9, recovery capability 5, recovery route 10, UI 3. Có kiểm tra phản hồi không tiết lộ email tồn tại, URL khôi phục cố định, quyền/session và giới hạn mật khẩu. Không sửa các module bảo mật này.

Đã chọn spec mới trong shard Auth thật hiện có của workflow, cả Chromium và WebKit. Đây là kiểm tra cấu hình; chưa chạy CI. Bốn ca resend có cooldown được loại khỏi lượt hồi quy này, không tính là đã thực thi.

## Giao diện và giới hạn

Đã xem ảnh lỗi EN desktop, EN mobile và VI mobile: form/nút/inline alert hiển thị, không thấy chồng lấn. Cả 16 ca mới kiểm tra không tràn ngang. Giữ nguyên CSS, palette và UI primitives.

**Đã ghi nhận, chưa sửa trong lô P1 này:** heading “Reset your password” và đoạn hướng dẫn ở `src/app/login/forgot-password/page.tsx` là tiếng Anh cố định, trong khi form chọn tiếng Việt. Đây là nội dung có sẵn trên nền trước sửa, không phải regression của bản vá. Không chứng nhận toàn trang đã đồng bộ ngôn ngữ.

Không chứng nhận tần suất lỗi mạng thực tế, email hosted đến inbox/spam, mở link để đổi mật khẩu thật, form hoàn tất đổi mật khẩu hoặc Google login thật. 40 ca là số test browser, không phải 40 chức năng mới hoặc chứng nhận 784/784.

## An toàn và bằng chứng

Mọi browser write và OAuth handoff được intercept; request gửi email không đến Auth/provider. Chỉ dùng cấu hình local loopback của database dùng một lần đã dừng; không chạy DB, tạo user/salon/booking, gửi email/SMS/call hay sửa dữ liệu Production. Không dùng secrets hosted. Không thay dependency, cookie, PKCE, schema, rate limit hoặc quyền.

Tài liệu đã đối chiếu: Next.js cài sẵn `node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md` (exception trong startTransition đi vào error boundary); [Supabase resetPasswordForEmail](https://supabase.com/docs/reference/javascript/auth-resetpasswordforemail) và changelog đã tải. Không thay cách dùng SDK/provider.

Bằng chứng ngoài repo: `/Users/huytran/nailiq-audit-results-20260907/forgot-password-recovery/` — browser-before.json, browser-final.json, compatibility.json, browser-summary.json, unit-final.json, build/typecheck/lint logs và ảnh. Các ca lỗi được giữ nguyên, không ghi đè bằng kết quả PASS.
