# Master Plan — Ngày 21: bộ chấm nghiệm thu pilot

Ngày 29/09/2026. Phạm vi P1-07 / Giai đoạn 5 của `docs/MASTER_PLAN.md`.
Đây là **chuẩn bị nghiệm thu local**, không phải kết quả pilot, triển khai hay
chấp thuận bán rộng rãi.

## Việc đã làm

- Thêm hàm thuần `evaluatePilotAcceptance` để tổng hợp bằng chứng **đã ẩn danh**;
  không đọc database, gọi provider hoặc thay đổi salon.
- Thêm lệnh đọc JSON local, kiểm cấu trúc chặt và chỉ in kết quả tổng hợp, không
  in mã người thử hoặc giá trị nhập sai. Tệp mẫu gắn nhãn synthetic rõ ràng.
- Tách ba trạng thái `pass`, `fail`, `not_proven`. Bất kỳ bằng chứng thiếu nào
  giữ toàn bộ kết luận ở `not_proven`; sự cố mất dữ liệu ghi nhận là `fail`
  ngay cả khi các phiếu khác chưa đủ.
- Tạo kiểm thử cho hai salon, thời gian 7–14 ngày, thành phần người thử, đủ năm
  việc, ngưỡng 80%, tạo hẹn dưới 60 giây, walk-in dưới 30 giây, không quá một
  lần trợ giúp ở ca đầu và ít nhất hai salon muốn tiếp tục.

## Cách ghi nhận ngoài thực tế

Mỗi salon dùng mã S1/S2, người quan sát dùng OBS1 và mỗi người thử dùng
mã P1/P2...; **không** điền tên,
email, số điện thoại hoặc mã khách vào bộ chấm. Người quan sát giữ phiếu gốc
riêng theo chính sách bảo mật của salon. Với mỗi người, ghi đủ năm việc theo
`masterplan-two-salon-human-observation-sheet.md`; phiếu Ngày 5 chỉ dùng cho
QA/Preview synthetic. Đánh dấu tự làm hay cần giúp và đo thời gian
thực tế. Không dùng thời gian automation hoặc dữ liệu synthetic để thay phép đo
người mới. Ghi riêng tổng số lần cần giúp trong ca đầu.

Bộ chấm áp dụng cách hiểu thận trọng: ít nhất 80% người thử phải **cùng lúc**
tự hoàn thành đủ năm việc, tạo hẹn dưới 60 giây và thêm walk-in dưới 30 giây.
Ngưỡng `dưới` là nghiêm ngặt: đúng 60 hoặc 30 giây chưa đạt. Mỗi salon cần ít
nhất một người thử. Mẫu phải có ít nhất một chủ lớn tuổi, hai tiếp tân ít dùng
công nghệ và ít nhất một người không phải người quen/nhân sự kỹ thuật.

## Trạng thái thực tế hôm nay

- **PASS local**: kiểm thử của bộ chấm với dữ liệu giả.
- **NOT PROVEN pilot**: chưa có biên bản 7–14 ngày của cả hai salon, chưa có phép
  đo năm việc bởi người mới, chưa có xác nhận tiếp tục từ cả hai salon.
- Chưa có màn hình nhập liệu cho chủ salon; bộ chấm hiện là hàm kỹ thuật thuần
  và lệnh QA local để tránh kết luận sai khi tổng hợp phiếu sau pilot.
- P1-01 thông báo/SMS qua NailIQ và callback provider còn cổng riêng; không
  được dùng kết quả bộ chấm này để tự tuyên bố Giai đoạn 4 hoặc 5 hoàn tất.

Sau quyết định hai salon: 15/15 unit tests, typecheck, lint và Next build
local PASS; fixture hai salon chỉ là dữ liệu synthetic. Không có phép đo người
thật nào được sinh ra từ các bài kiểm thử này.

## Chạy thử không dùng dữ liệu thật

Từ thư mục repository:

```bash
npx tsx scripts/qa/evaluate-masterplan-pilot.ts scripts/qa/fixtures/masterplan-pilot-synthetic.json
```

Lệnh mẫu có thể cho kết quả tính toán `PASS`, nhưng dòng đầu luôn ghi **DỮ
LIỆU GIẢ** và lệnh trả **exit code 1**, không thể được pipeline coi là cổng
pilot đạt. Khi nhập phiếu thật, chỉ dùng mã salon/người quan sát/người thử,
không dùng tên, email, số điện thoại hay mã khách. Lệnh chỉ tính từ dữ liệu
được cung cấp; nó không chứng thực người quan sát, độ dài pilot hoặc phiếu gốc.

Mẫu nhập trống cho quan sát thật nằm tại
`scripts/qa/fixtures/masterplan-pilot-human-blank.json`. Mẫu này giữ mọi kết
quả chưa xác nhận là `null` và chưa có người thử. Chạy cùng lệnh trên với tệp
đó phải trả `NOT_PROVEN` (exit code 1); chỉ sao chép ra tệp riêng để nhập số
đo đã đối chiếu phiếu gốc, không sửa mẫu gốc thành “kết quả thật”.

Kiểm tra bổ sung: cổng cohort chỉ chấp nhận đúng mã `S1` và `S2`, không còn
đánh dấu PASS cho hai mã salon khác. Dữ liệu synthetic có thể cho kết quả
công thức PASS nhưng cổng nghiệm thu luôn `NOT_PROVEN` và exit code 1.
**18/18 unit tests**, typecheck, lint và Next build local PASS; mẫu người thật
trống vẫn trả `NOT_PROVEN`. Đây là bằng chứng bộ chấm, không phải pilot đã diễn ra.

## Cổng tiếp theo

Huy đã chỉ định Hi-Lite Head Spa và Hi-Lite Studio cho cohort pilot; sau đó
loại Tech Nails Salon cũ và quyết định **chỉ lấy hai salon pilot**. Không cần
gửi thư mời hoặc chọn salon thứ ba. Tiếp theo xác định người quan sát, người
thử thực tế, thiết bị, lịch 7–14 ngày và phương án xử lý sự cố. Chỉ tạo booking/nhắn tin
thật khi salon cụ thể phê duyệt kịch bản và kênh. Sau khi thu đủ phiếu, nhập
duy nhất số đo đã ẩn danh vào bộ chấm, lưu kết quả từng cổng cùng bằng chứng
và giải thích mọi `fail` hoặc `not_proven`. Không mở cohort 10 salon khi
P1-01 hoặc điều kiện pilot còn mở.
