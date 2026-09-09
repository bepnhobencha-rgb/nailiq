# Kiểm tra độ tin cậy của test sau PR #1371 — 2026-09-09

## Phạm vi và môi trường

- Base `6d219a3b7fcc2b157544d17a8f8a716be71364ba`; nhánh local `fix/post-release-qa-20260909`.
- Chỉ sửa test/helper. Không thay đổi mã sản phẩm, schema, cấu hình salon hay quyền Production.
- Next production build local, Node 20, Supabase CLI 2.109.1, database dùng một lần; Auth thật trên loopback và Mailpit. SMS, email ngoài hệ thống và cuộc gọi bị tắt.
- Chromium desktop và WebKit giả lập iPhone 14, múi giờ America/Los_Angeles. Không phải kiểm chứng iPhone vật lý.
- Bằng chứng gốc: `/Users/huytran/nailiq-audit-results-20260907/booking-country-select-contrast`; bằng chứng lượt này: `/Users/huytran/nailiq-audit-results-20260907/post-release-qa`.

## 1. Booking nhóm: test chưa thiết lập tên trước khi kiểm tra quay lại

**Mức độ:** trung bình đối với độ tin cậy CI. **Nguyên nhân đã xác minh trong trace.**

Main E2E 34391908633: ca WebKit bước 3 → quay lại bước 2 nhận `Test Guest` thay vì `Mai`, rồi PASS khi retry. Các DOM snapshot khôi phục từ trace cho thấy tên vẫn là `Test Guest` ngay sau `fill("Mai")`, sau chọn dịch vụ/thợ và trước khi nhấn Next. Trace này không chứng minh người dùng bị mất tên do quay lại bước trước.

Sửa helper dùng hàm nhập React có sẵn, kiểm tra input hiển thị/chỉnh sửa được, xác nhận giá trị trước và sau khi chọn dịch vụ/thợ. Giữ nguyên assertion sau điều hướng. Bổ sung ca gõ `Mai Anh` bằng bàn phím, chuyển bước rồi quay lại để kiểm tra thao tác người dùng thật trong trình duyệt.

**PASS:** 4 kịch bản × 2 engine × 3 lần = 24/24 lượt, 0 retry. Bằng chứng `group-repeat/results.json`, `group-repeat.log`, `group-name-trace.json`.

## 2. Auth: cleanup dùng context đã đóng che lỗi gốc

**Mức độ:** trung bình đối với chẩn đoán CI. **Đã sửa local.**

Trace main cho thấy assertion `main` bị ẩn xuất hiện trước lỗi cleanup `Target page, context or browser has been closed`. Cleanup trong `finally` ghi đè lỗi ban đầu. Trace PR trước đó cũng có lỗi Mailpit sau khi context đóng, dù assertion sản phẩm đã PASS. Chưa xác định nguyên nhân browser/context đóng trong CI.

Sửa cleanup Mailpit dùng API context riêng, chỉ cho HTTP loopback, không theo redirect và chỉ xóa thư khớp email test. Mọi bước cleanup vẫn chạy; lỗi ban đầu và lỗi cleanup đều được giữ, không chuyển lỗi thành PASS. Giữ nguyên assertion, timeout và cấu hình retry của các spec.

**PASS:** 9/9 unit test, gồm trường hợp context đã đóng, giữ đúng lỗi assertion, nhiều lỗi cleanup, chỉ xóa thư của test, từ chối mailbox bên ngoài. Proof Chromium riêng đóng cả browser/context cũng xác minh cleanup độc lập.

## 3. WebKit: lỗi RSC tại thời điểm reload trang xác nhận

**Trạng thái:** quan sát được một lần; nguyên nhân chưa chứng minh.

Lượt đầu 36 ca đạt 35 PASS, 1 FAIL, 0 retry. Ca signup tiếng Việt WebKit hoàn tất các assertion đăng ký/tạo salon/dashboard nhưng assertion không có `pageerror` thất bại. Lỗi có nội dung `due to access control checks` cho RSC trang chủ trên localhost:3443.

Trace cho thấy lỗi xảy ra 12,5 ms sau khi bắt đầu reload trang setup, đồng thời với prefetch trang chủ. URL RSC tương ứng trả 200 sau reload. Không đủ bằng chứng kết luận lỗi TLS, CORS, Supabase hay việc đóng tab. Không bỏ qua pageerror, không đổi proxy/CSP và không thêm chờ để làm xanh test theo giả thuyết.

Bổ sung chẩn đoán cho cả tab đăng ký và tab xác nhận: thời điểm requestfailed/pageerror/reload, origin/path và phân loại lỗi dạng boolean. Không ghi query string, token hay raw error vào attachment chẩn đoán. Bằng chứng thất bại được giữ tại `initial-36/`.

Lặp riêng signup tiếng Việt WebKit **5/5 PASS, 0 retry** (`auth-mobile-repeat/`). Cả năm lần đều ghi nhận request trang chủ bị hủy 5–8 ms sau khi bắt đầu reload nhưng không có pageerror. Đã xác nhận reload hủy prefetch; chưa chứng minh tại sao lượt đầu sinh pageerror hoặc khẳng định lỗi đã được sửa.

## 4. Bảy HTTP 503 của group-quote trên Production

**NOT_PROVEN:** nguyên nhân và ảnh hưởng khách hàng chưa xác định.

Trong cửa sổ 18:54:50–19:22:28.088 UTC ngày 2026-09-09, deployment của SHA base ghi 7 POST `/api/booking/group-quote` trả 503 và 6 trả 400. Log hiện có không kèm mã lỗi trong response, request ID hay tenant. Không có error/fatal log không đủ để loại trừ lỗi dependency hoặc nhánh trả lỗi có chủ đích.

Route và các module tính quote không đổi trong bản sửa country selector. Truy vấn chỉ đọc system catalog xác nhận hiện tại hai RPC `rate_limit_hit`, `quote_group_booking` tồn tại, là security definer và `service_role` có quyền EXECUTE. Điều đó không chứng minh trạng thái ở thời điểm bảy request hoặc nguyên nhân của chúng.

Không gọi POST Production để thử, không truy vấn/sửa dữ liệu khách hàng và không thay đổi API theo phỏng đoán. Xem `PRODUCTION_503_REVIEW.md` và `production-rpc-metadata.json` trong thư mục bằng chứng.

## Gate và giới hạn

- PASS: production build local; typecheck; ESLint các file thay đổi; unit cleanup 9/9; lặp booking quay lại 24/24.
- Lượt đầu 36 ca: 35 PASS, 1 FAIL; lỗi được giữ nguyên trong báo cáo, không tính các lần chạy lặp thành chức năng mới.
- Lượt mở rộng `final-auth-group/`: **98 PASS, 2 FAIL, 0 retry/flaky/skip** trong 100 ca. Cả 30 Auth và 68 booking nhóm thông thường PASS. Hai ca OTP thất bại trước bước nhập tên: trace API `/api/booking-otp/send` trả `503 {error: "sms_suppressed"}`. Spec yêu cầu `DEMO_OTP=true`, trong khi app phục vụ lượt Auth thật đặt `DEMO_OTP=false`. Đây là sai cấu hình lượt chạy, không phải bằng chứng regression của helper.
- Chạy riêng hai ca OTP sau khi khởi động lại cùng build với `DEMO_OTP=true`, vẫn giữ toàn bộ outbound suppression: **2/2 PASS, 0 retry** (`otp-demo/results.json`, `otp-demo.log`). Không thay đổi mã sản phẩm, không gửi SMS thật. Tổng phạm vi có kết quả PASS phù hợp là 100 ca trình duyệt, được kiểm chứng qua hai cấu hình; không phải một lượt 100/100 xanh và không xóa lịch sử thất bại.
- Independent acceptance review: không còn finding cần sửa trong patch test/helper. Lỗi pageerror ban đầu vẫn mở; nguyên nhân browser/context đóng trong CI và bảy HTTP 503 Production vẫn chưa xác định.
- Dọn môi trường PASS: đã dừng app và xóa container/data volume của riêng project `nailiq-post-release-20260909`; giữ các volume local có sẵn khác. Các cổng 3116, 3443, 54321, 54322, 54324 đều đóng. Đã dừng Colima, trả về trạng thái ban đầu. Log ở `cleanup.log`, `colima-stop.log`, `verification-summary.json`.
- Tại thời điểm chốt kiểm chứng local, patch chưa có CI/Preview; kết quả xuất bản được theo dõi riêng trên PR. Không coi kết quả local là đã sửa trên Production hoặc hoàn thành 784 chức năng.
