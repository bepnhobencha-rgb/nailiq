# Đổi mật khẩu — bảo toàn phiên khi đọc quyền salon lỗi

Ngày 2026-09-09. Trạng thái **PASS_LOCAL; chưa commit/push/CI/Preview/Production**.
Nhánh `fix/reset-membership-read-recovery-20260909`, base main `bd2a15b74dd7f5cf8442db07d4060f3f9a7ef110`.

## Lỗi được xác nhận
P1 về khả năng duy trì phiên đăng nhập trong luồng khôi phục tài khoản, Master Plan giai đoạn 1/4.

Route /login/reset-password gộp membershipError với kết quả không có membership và gọi signOut({scope:"global"}). Lỗi truy vấn không chứng minh tài khoản bị thu hồi quyền. Action hoàn tất đổi mật khẩu hiện đã phân biệt hai tình huống này; page trước sửa chưa phân biệt.

Bộ test gọi Server Component thật với các phụ thuộc giả lập tái hiện **4 FAIL, 4 PASS** trên baseline: timeout, mất kết nối database, lỗi fetch và response lỗi kèm partial data đều kích hoạt global sign-out. Đây là bằng chứng lời gọi sai trong điều kiện mô phỏng; không phải xác nhận tài khoản live từng bị đăng xuất vì lỗi này. Theo [tài liệu Supabase](https://supabase.com/docs/reference/javascript/auth-signout), scope global tác động các phiên trên mọi thiết bị; access token đã phát hành có thể còn hiệu lực đến khi hết hạn.

## Bản sửa
- Tách membershipError thành nhánh fail-closed, redirect tới /login/forgot-password?notice=temporarily_unavailable. Không hiển thị form đặt mật khẩu và không gọi sign-out.
- Khi query thành công nhưng không có membership, vẫn giữ xử lý từ chối và global sign-out hiện có.
- Chỉ render form sau khi recovery capability/session và membership được xác nhận.
- Không đổi Server Action, chính sách/password validation, session guard, quyền database, cookie, provider, theme, copy hay metadata.
- Thay đổi production: một file page.tsx, 6 dòng thêm/1 dòng xóa.

## Kiểm chứng
| Kiểm tra | Kết quả |
| --- | --- |
| Baseline page tests | 4 lỗi được tái hiện; 4 ca đối chứng đạt |
| 8 page regression sau sửa | PASS |
| Vòng hẹp auth/recovery/UI: 5 file | 27 PASS |
| Vòng rộng liên quan auth + page/UI: 10 file | 68 PASS; bao gồm 27 ca trên, không cộng lặp |
| Build production Webpack | PASS |
| Typecheck chạy sau build | PASS |
| Lint file sửa/mới, git diff --check | PASS |
| Browser trên route thật, Auth/database HTTP giả lập ở loopback | 4/4 PASS: EN/VI × Chromium 320px/WebKit iPhone 13 |
| Render/notice/localization/geometry | 8/8 PASS |

Browser route test dùng Next production build thật, createServerClient và recovery guard thật. Session/capability ký bằng secret tổng hợp local; server HTTP giả lập /auth/v1/user, RPC xác nhận phiên và query membership. Trong mỗi ca:
1. Cho membership trả HTTP 503: route chuyển đến notice tạm thời không khả dụng, không có ô mật khẩu.
2. Kiểm tra request tới query select=id đã xảy ra và không có /auth/v1/logout.
3. Giữ nguyên browser context/cookie; khôi phục query membership, mở lại /login/reset-password và thấy hai ô mật khẩu.
4. Không có uncaught pageerror, browser POST hoặc request logout/update password. Chỉ RPC đọc xác nhận phiên được POST tới fake server.

8 render checks kiểm tra SSR/hydration, ưu tiên cookie/localStorage EN/VI, notice, không tràn ngang, header không đè form, nút tối thiểu 44px và màu computed nhất quán. Đã xem ảnh VI ở 320px và WebKit. Agent-browser cũng xác nhận notice trên local build.

## Rà soát lần hai
PASS cho phạm vi sửa:
- Lỗi read và partial-error không thể cấp quyền; không suy đoán mất quyền từ lỗi.
- Thiếu/không hợp lệ recovery session bị chặn trước membership query.
- Kết quả không còn membership vẫn bị từ chối theo policy cũ.
- Successful membership vẫn mở form; không thêm cơ chế bỏ qua auth.
- Dùng redirect ngoài try/catch như tài liệu Next cài trong repo; không catch nhầm NEXT_REDIRECT.
- Thay đổi không chứa schema, dependency, secret hoặc thông tin khách hàng.

## Giới hạn
- Không có email inbox/provider thật, không commit mật khẩu thật, không chứng nhận toàn bộ 784 chức năng.
- CI/Preview/Production cho bản sửa mới chưa chạy. Test HTTP giả lập ngoài repo không được tính là CI.
- Bản sửa xử lý response query có error. Rejection ngoài contract query và hành vi sign-out khi xác nhận mất membership không được thay đổi.
- Header EN của trang đặt mật khẩu và thanh độ mạnh là mục tồn tại từ trước, không gộp vào bản sửa phiên đăng nhập này.

## Bằng chứng và cleanup
Thư mục /Users/huytran/nailiq-audit-results-20260907/reset-membership-read-recovery:
red.log, unit.log, auth-regression.log, build.log, typecheck.log, lint.log, route-browser.cjs, route-browser.json, route-browser.log, render-check.cjs, render-check.json, render-check.log và ảnh PNG.
App local 3117, fake HTTP 54321 và các browser đã dừng; lsof xác nhận không còn listener trên hai cổng. Không khởi động database, không sửa dữ liệu salon live.

