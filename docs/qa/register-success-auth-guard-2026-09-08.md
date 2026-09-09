# Chặn trang tạo salon thành công khi chưa đăng nhập

Ngày kiểm tra: 2026-09-08. PR hiện có: [#1342](https://github.com/bepnhobencha-rgb/nailiq/pull/1342).

**PASS local trong phạm vi auth guard; chưa cập nhật PR hoặc phát hành bản này.**

## Lỗi tái hiện

Production main `6c82c32f2c12d0d26be5057cd0820fb9dd2f1310` trả HTTP 200 và chứa markup `registration-launch-status` khi truy cập không có cookie `/register/success?slug=e2e-readonly-success-proof`. Không submit form hoặc tạo dữ liệu live. Đây là thông báo thành công sai cho người chưa đăng nhập, không phải bằng chứng đã tạo salon hoặc lộ dữ liệu salon.

Nhánh PR cũ có guard nhưng chưa merge. Đã đưa main mới vào nhánh local bằng merge chưa commit, giữ nguyên nội dung guard: `getUser()` phía server và chuyển về `/register` khi không có user trước khi trả children. Không thay policy, schema hoặc quyền salon.

## Bổ sung kiểm thử

- Unit: phiên hợp lệ, signed-out và phiên hết hạn/không hợp lệ.
- Browser: signed-out có/không có slug; HTTP 307 tới `/register`, payload không có markup thành công, browser không thoáng hiện nội dung thành công rồi chuyển trang.
- Dùng lại hành trình đăng ký hiện có: Auth thật được seed trên QA → tạo salon → success → Dashboard; kiểm tra trial 14 ngày, không thẻ, membership owner và các provider flags mặc định tắt.
- Browser chạy Chromium desktop và WebKit iPhone 14 trên production build Next 16.3.4, Node 20.20.2, demo tắt, workers=1, retries=0.

| Gate | Kết quả |
| --- | --- |
| Focused unit | 5 PASS |
| Full unit | 4.527 PASS, 1 SKIP, 0 FAIL |
| Build + typecheck | PASS |
| ESLint các file thay đổi | PASS |
| E2E | 6/6 PASS, không skip/flaky/retry |
| Guard tránh Production + schema parity QA | PASS |
| Dữ liệu sau teardown | 0 salon, user, booking, client |
| Dọn runtime | Server dừng, project/volume QA riêng xóa, Colima dừng; giữ 3 volume cũ |

Ảnh trang đăng ký sau redirect đã xem trên hai browser: theme tối/vàng, input/nút đọc được trong viewport chụp; không sửa style. Đợt này không chứng nhận toàn bộ màu/form hoặc 784 chức năng.

Server log có một dòng `The destination stream closed early`, digest `1186848737`, không stack chi tiết. Các ca browser đạt; chưa xác định request/nguồn gây lỗi. Giữ `NOT_PROVEN`, không gọi log sạch và không suy diễn lỗi Supabase/CORS/connection pool.

## Giới hạn

Đây là auth guard; không bổ sung xác minh ownership của slug trên trang success. Test tạo user đã được xác nhận email qua Auth API local, không kiểm tra email confirmation/OAuth provider thật. Các gate CI/Preview cũ của PR ở commit `da1bb65b` không thay thế kết quả trên main mới. Cần commit/push cập nhật PR hiện có để chạy lại CI/Preview trước quyết định merge riêng.

Bằng chứng: `/Users/huytran/nailiq-audit-results-20260907/register-success-guard/` — baseline HTTP, unit JSON, build/typecheck, browser report/ảnh, server log và cleanup.

## Bổ sung gate CI sau đối chiếu artifact

Run đầu của bản refresh `a68a775d` có CI/E2E SUCCESS nhưng artifact chỉ có 458 ca PASS: workflow dùng danh sách spec cố định, thiếu file guard mới. Hai ca guard chưa chạy trong CI dù đã PASS local/Preview; không gọi đây là CI chứng minh guard. Đã thêm file vào shard non-RC và bước WebKit riêng bao gồm hai ca guard cùng hành trình tạo salon bằng Auth thật. Báo cáo WebKit có tên riêng để giữ nguyên artifact của shard chính. Không đổi mã ứng dụng, assertion hoặc retry để xử lý thiếu sót này. Kết quả cuối phải đọc trên SHA mới.
