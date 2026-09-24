# Ngày 6 — bàn giao kiểm thử Chủ salon trên iPhone

Trạng thái: **đã thực hiện local QA**, xem
[bằng chứng ngày 6](masterplan-day-6-owner-2026-09-24.md). Chưa nghiệm thu
người dùng trên iPhone vật lý hoặc phát hành.
Đây là thứ tự công việc đề xuất sau Receptionist Center, dựa trên
`docs/MASTER_PLAN.md`, mục Giai đoạn 3. Không đồng nhất số giai đoạn với số ngày,
không tuyên bố tồn tại một lịch ngày 6 chi tiết đã được nghiệm thu trước đó.

## Năm việc phải kiểm chứng

1. Mở Trang chủ: hiểu số lịch hôm nay, thợ bận/rảnh và việc cần xử lý.
2. Xem doanh thu: phân biệt giá trị dịch vụ, tiền đã thu và số liệu chưa xác minh.
3. Tìm khách: tên/điện thoại, đúng salon; thông tin đầy đủ chỉ ở nơi có quyền.
4. Xem lịch và chi tiết: chạm được bằng một tay; quay lại không mất ngày đang xem.
5. Xử lý cảnh báo: hiểu nguyên nhân, hành động tiếp theo và kết quả thật; không
   tự gửi SMS/email hoặc thanh toán trong QA.

## Cách chạy an toàn

- Dùng stack QA local có sẵn, tenant synthetic riêng, tài khoản Auth vai trò Owner.
- Không dùng demo cookie để chứng minh quyền; tách Owner, receptionist và salon khác.
- Chặn mọi provider, không credentials Production, không email/SMS/call/payment thật.
- iPhone SE và Pro Max, EN/VI; iPad/desktop kiểm tra hồi quy bố cục.
- Computer Use kiểm tra chữ, dấu, label, touch target, bàn phím che form,
  safe-area, scroll ngang, modal/focus, trạng thái chờ/lỗi/không có dữ liệu.
- Đối chiếu UI với database QA; race/retry ở các thao tác ghi được phép.
- Dọn tenant, Auth user và global customer profiles có marker sau mỗi bộ test.

## Điểm tái sử dụng đã kiểm tra source

- `src/app/dashboard/[slug]/page.tsx`: Trang chủ salon.
- `src/app/dashboard/[slug]/center/page.tsx`: lịch/chi tiết tiếp tân.
- `src/app/dashboard/[slug]/pulse/page.tsx`: Business/reports.
- `e2e/dashboard.spec.ts`: đã có mobile owner home/settings checks nhưng các
  ca này dùng demo cookie — cần đổi sang fixture Owner Auth thật trước nghiệm thu.
- `e2e/dashboard-load-performance.spec.ts`,
  `e2e/receptionist-center/mobile-customer-search.spec.ts`,
  `e2e/receptionist-center/owner-no-regression.spec.ts`: kiểm tra khả năng tái sử dụng,
  chưa có kết quả chạy trong lượt bàn giao này.

## Điều kiện đóng

- Năm việc PASS bằng UI và kiểm chứng quyền/dữ liệu, không P0/P1 chưa xử lý.
- Build/typecheck/i18n/targeted tests PASS; ghi cả warning và ca chưa chạy.
- Người dùng mới thao tác một tay trên iPhone vật lý được ghi riêng; browser
  emulation và Computer Use trên Mac không thay thế bằng chứng này (V1-24).
- Bản sửa local không được gọi là Live. Commit/push/PR/Preview/Production cần
  được Huy duyệt đúng phạm vi trước khi thực hiện.

## Mang theo từ ngày 5

- Các sửa lỗi receptionist đã kiểm thử local vẫn chưa phát hành.
- Nghiệm thu thời gian của tiếp tân mới thật (V1-21) chưa có.
- Theo dõi riêng log React `The destination stream closed early.`: đã tái hiện
  bằng ngắt render và correlation request thật trên QA (`POST /register` bị
  đóng khi chuyển trang, GET cuối journey bị ngắt). Không suy ra nguyên nhân
  mọi log lịch sử hoặc Production; giữ nguyên error reporter.
- Không chặn việc chuẩn bị/test Owner local vì chưa có phê duyệt phát hành;
  không đánh dấu toàn bộ Master Plan hoặc ngày 5 đã nghiệm thu thương mại 100%.
