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

## Checkpoint và phiếu nghiệm thu còn lại — 24/09/2026

- PR #1424 hiện OPEN/Draft, head `6c31974ac4568e30fb083b459462fe9a1b9f62cb`.
  Đã xuất bản Preview và kiểm chứng Owner/Receptionist bằng Computer Use;
  xem [bằng chứng hosted và CI](day5-day6-preview-verification-2026-09-24.md).
  Các ghi chú chỉ-local ở phần đầu là checkpoint lịch sử, không phải trạng
  thái phát hành hiện tại. Chưa merge/deploy Production.
- Cổng còn cần người thật: chủ mới thao tác một tay trên iPhone vật lý.
  Chuẩn bị lại tenant QA riêng và tài khoản Owner khi đã có người tham gia;
  không tái dùng tài khoản synthetic đã bị xoá hoặc salon kinh doanh.
  Không đưa mật khẩu/token vào phiếu, không gửi thông báo hay thanh toán.
- Người quan sát chỉ đọc nhiệm vụ, không chỉ vị trí nút. Ghi thời gian và số
  lần trợ giúp thực tế; Master Plan không đặt ngưỡng 60 giây cho năm việc
  Admin nên không tự áp ngưỡng đó vào V1-24.

| Nhiệm vụ đưa cho chủ mới | Bằng chứng cần ghi | Kết quả |
|---|---|---|
| Cho biết hôm nay có bao nhiêu lịch và ai đang bận | Câu trả lời so với fixture, có cần chỉ dẫn không | Chưa chạy |
| Cho biết giá trị dịch vụ hoàn tất; đó có phải tiền đã thu không? | Đọc đúng số và hiểu chú thích nguồn | Chưa chạy |
| Tìm khách giả theo tên hoặc số và mở chi tiết | Đúng khách, không nhầm số, đóng được bảng | Chưa chạy |
| Xem lịch ngày mai rồi quay lại hôm nay | Chạm được một tay, giữ đúng ngày sau tải lại | Chưa chạy |
| Mở một cảnh báo và nói cần làm gì tiếp | Hiểu nguyên nhân, đến đúng màn hình, không gửi thật | Chưa chạy |

Ghi kèm: mã người tham gia (không PII), iPhone/iOS/Safari, EN hoặc VI, SHA,
ngày giờ salon, bắt đầu/kết thúc từng việc, trợ giúp, chỗ do dự/bị che và lỗi.
Không đánh dấu PASS nếu người quan sát làm hộ. Dừng nếu lộ dữ liệu salon khác,
thao tác nhầm hoặc có ý định gửi/thu tiền thật. Sau buổi test dọn đúng fixture
và thu hồi phiên. Kết quả máy thật không được suy từ emulation trên Mac.

### Bàn giao iPhone đang chờ người dùng — 24/09/2026

- Đã tạo link chia sẻ Preview tạm theo phê duyệt của Huy; không lưu token
  hoặc mật khẩu trong repository. Chỉ dùng branch alias đã kiểm chứng,
  deployment `dpl_BT1f9uLZgdFWZt5ivgCNr1TboxX5`, SHA như trên.
- Đã xác minh cấu hình Preview trỏ QA `uhpzafoiifupyypkcwln` và các cổng
  SMS/email/call/payment bị tắt. Không thay đổi Production hoặc firewall.
- Fixture mới đang hoạt động để bàn giao, chưa dọn: salon
  `ee40a150-4921-4308-bdc3-5e7f4e497424`, slug
  `e2e-day56-hosted-eb53b3e7`; tenant kiểm tra cách ly
  `e2e-day56-isolation-eb53b3e7`. Đây không phải fixture đã dọn ở lượt trước.
- Có tài khoản Owner/receptionist synthetic, ba nhân viên, hai dịch vụ,
  ba lịch synthetic. Ngày fixture 2026-09-24, múi giờ salon UTC.
- Computer Use đã đăng nhập Owner thành công qua branch alias và thấy
  đúng salon `E2E Day56 Hosted QA`. Link immutable ban đầu mở được form
  nhưng submit không thành công; link alias thay thế đã được kiểm chứng.
  Link cũ hiện chuyển về đăng nhập Vercel khi kiểm tra không có cookie.
- Chưa có kết quả iPhone vật lý hoặc chủ mới: không đánh dấu V1-24 PASS.
  Huy thử trên iPhone là bằng chứng thiết bị thật, không tự đồng nghĩa
  nghiệm thu của người dùng lần đầu.
- Sau khi người dùng kết thúc: đóng phiên test, dùng lệnh `finish` trong
  phiên fixture 25041 để thu hồi phiên và dọn đúng dữ liệu synthetic;
  kiểm chứng không còn fixture, đồng thời thu hồi link chia sẻ Preview.
  Không tự dọn trước khi người dùng hoàn thành.

## Mang theo từ ngày 5

- Các sửa lỗi receptionist đã kiểm thử local vẫn chưa phát hành.
- Nghiệm thu thời gian của tiếp tân mới thật (V1-21) chưa có.
- Theo dõi riêng log React `The destination stream closed early.`: đã tái hiện
  bằng ngắt render và correlation request thật trên QA (`POST /register` bị
  đóng khi chuyển trang, GET cuối journey bị ngắt). Không suy ra nguyên nhân
  mọi log lịch sử hoặc Production; giữ nguyên error reporter.
- Không chặn việc chuẩn bị/test Owner local vì chưa có phê duyệt phát hành;
  không đánh dấu toàn bộ Master Plan hoặc ngày 5 đã nghiệm thu thương mại 100%.
