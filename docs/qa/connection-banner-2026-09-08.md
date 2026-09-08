# QA: cảnh báo mất kết nối và Reload — 2026-09-08

Phạm vi: bản local từ main `0c35bea4`, Owner QA có đăng nhập bằng mật khẩu, Chromium desktop và WebKit iPhone 14. Database dùng riêng trên loopback, chặn SMS/email/calls và không có credential provider. Không thao tác dữ liệu salon live.

## QA-CB-01 — test mất kết nối tự skip

**Đã sửa ở test, local PASS.** Test cũ dùng demo-cookie, không tạo Supabase session. `ReceptionistCenter` chuyển sang polling khi thiếu session và không mở Realtime channel; chặn WebSocket không tạo được trạng thái lỗi. Ca kiểm tra tự skip khi không thấy banner.

Tái hiện trên build local: Chromium và WebKit đều skip (0 PASS, 2 skip). Bản sửa tạo Owner QA, đăng nhập qua giao diện, không dùng demo-cookie và bắt buộc quan sát socket bị chặn. Banner, Reload và nhãn Updated phải hiện; thiếu điều kiện sẽ FAIL. Sau khi nút Reload tạo navigation request, mở lại kết nối đến server local thật, chờ acknowledgement đăng ký channel của đúng salon và xác nhận banner biến mất. Fixture dọn cả salon và auth user.

Kết quả: 2/2 lượt đầu PASS; 3 lần lặp mỗi engine, tổng 6/6 PASS, không skip/flaky/retry. Hai luồng Owner đồng bộ lịch qua Realtime và polling fallback cũng PASS trên Chromium, retries=0. Build/typecheck/lint/diff check PASS. Chưa chạy CI/Preview hay phát hành bản sửa test này.

## QA-CB-02 — quan sát che nội dung trên mobile

**Còn mở, có cách đọc sau khi cuộn.** Với viewport iPhone của bộ test và banner giới hạn kênh tin nhắn phía trên, nhãn Updated nằm gần y=541 CSS px. Kiểm tra `elementFromPoint` tại tâm nhãn trả về nút Ask Coco; ảnh xác nhận nút nổi che nhãn. Reload vẫn bấm được và phục hồi kết nối trong ca kiểm tra chính.

Cuộn cảnh báo vào giữa viewport đưa nhãn lên khoảng y=307 CSS px; phép kiểm tra điểm trúng nhãn và ảnh đều xác nhận đọc được. Diagnostic tiếp tục Reload và PASS. Lượt diagnostic ban đầu dùng mouse wheel bị Playwright từ chối trên mobile WebKit; đó là giới hạn lệnh test, không phải lỗi ứng dụng. Lượt sau dùng scrollIntoView thành công.

Đây là quan sát UX có thể tái hiện trong fixture local; chưa kiểm tra toàn bộ viewport hoặc salon live. Bản sửa hiện tại chỉ phục hồi test bị skip và kiểm tra Reload, không thay bố cục/nút nổi. Không ghi nhận toàn bộ giao diện là 100% PASS từ kiểm tra này.

Bằng chứng local: `/Users/huytran/nailiq-audit-results-20260907/connection-banner-coverage/` gồm JSON kết quả, trace, ảnh trước/sau cuộn và log chẩn đoán. Hai ca được phục hồi chỉ có bằng chứng local; số skip chính thức trên main vẫn là 18 cho đến khi PR mới được nghiệm thu.
