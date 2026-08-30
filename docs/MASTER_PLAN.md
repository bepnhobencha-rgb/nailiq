# NAILIQ MASTER PLAN — TỪ SẢN PHẨM ĐẾN BÁN HÀNG

Ngày bắt đầu: 21/07/2026
Mục tiêu: Có khách hàng trả tiền đầu tiên với một sản phẩm đơn giản, ổn định và dễ sử dụng.

## Nguyên tắc điều hành

1. Không thêm tính năng mới nếu chưa giúp khách đăng ký, vận hành salon hoặc trả tiền.
2. Tiếp tân phải dùng được mà không cần đào tạo dài.
3. Admin phải thao tác thuận tiện bằng một tay trên iPhone.
4. Mọi thay đổi phải đi qua Preview trước khi lên production.
5. Không bán rộng rãi khi đăng ký, lịch hẹn, SMS hoặc dữ liệu khách hàng chưa ổn định.

## GIAI ĐOẠN 1 — TẠO MÔI TRƯỜNG KIỂM THỬ

Thời gian: 2–3 ngày

### Công việc

- Áp dụng migration trial 14 ngày trên Supabase.
- Kiểm tra Supabase Authentication: đăng nhập Google; liên kết đăng nhập qua
  email; URL chuyển hướng; email xác nhận.
- Tạo Vercel Preview từ nhánh đang làm việc.
- Kiểm tra build và các biến môi trường.
- Tạo một salon thử nghiệm riêng, không sử dụng dữ liệu khách thật.

### Hành trình phải kiểm tra

Trang chủ → Dùng thử → Google/email → Nhập tên salon → Dashboard → Thiết lập salon.

### Điều kiện hoàn thành

- Đăng ký mới thành công trên điện thoại.
- Salon mới nhận đúng trial 14 ngày.
- Không cần thẻ tín dụng.
- Người dùng được đưa tới đúng Dashboard.
- Không có lỗi nghiêm trọng trong Vercel logs.

### Quyết định

Nếu chưa đạt, dừng lại sửa. Không chuyển sang thiết kế chi tiết hoặc bán hàng.

## GIAI ĐOẠN 2 — HOÀN THIỆN UX TIẾP TÂN

Thời gian: 5–7 ngày

### Năm công việc cốt lõi

1. Xem lịch hôm nay.
2. Tạo lịch hẹn.
3. Thêm khách vãng lai.
4. Đổi trạng thái khách.
5. Tìm thông tin khách hàng.

### Thiết kế yêu cầu

- Chữ tối thiểu 16px cho nội dung quan trọng.
- Vùng chạm tối thiểu 44 × 44px.
- Không quá năm lựa chọn ngang hàng.
- Dùng từ ngữ đời thường, không dùng thuật ngữ kỹ thuật.
- Màu đỏ chỉ dành cho lỗi hoặc việc khẩn cấp.
- Nút chính luôn ở vị trí ổn định.
- Khi thao tác thành công phải có xác nhận rõ ràng.
- Thao tác nguy hiểm phải yêu cầu xác nhận.

### Hai chế độ Front Desk

**Bình thường:** Hiển thị lịch, nhân viên và danh sách chờ ở mức dễ đọc.

**Giờ cao điểm:**

- Nút và chữ lớn hơn.
- Ẩn báo cáo và thông tin phụ.
- Làm nổi bật khách đang chờ, khách trễ và lịch cần xử lý.
- Không thay đổi vị trí các thao tác quen thuộc.

### Điều kiện hoàn thành

Một người chưa từng dùng NailIQ có thể tạo lịch và thêm walk-in trong dưới 60
giây mà không được hướng dẫn.

## GIAI ĐOẠN 3 — HOÀN THIỆN ADMIN TRÊN IPHONE

Thời gian: 5–7 ngày

### Cấu trúc chính

Thanh điều hướng dưới gồm: Trang chủ; Hôm nay; Khách hàng; Kinh doanh; Thêm.

### Trang chủ Admin chỉ cần trả lời năm câu hỏi

- Hôm nay có bao nhiêu lịch?
- Salon đang kiếm được bao nhiêu?
- Có khách hoặc lịch nào cần xử lý?
- Nhân viên nào đang bận hoặc trống?
- Việc quan trọng tiếp theo là gì?

### Cách hiển thị

- Đưa cảnh báo và việc cần làm lên trên.
- Doanh thu và số lịch nằm trong các thẻ lớn.
- Báo cáo chi tiết nằm sâu hơn, không xuất hiện ngay màn hình đầu.
- Cài đặt dùng danh sách giống ứng dụng Settings trên iPhone.
- Các biểu mẫu dài được chia thành từng màn hình nhỏ.
- Lưu tự động khi an toàn; thông báo rõ khi đã lưu.

### Điều kiện hoàn thành

Admin có thể dùng một tay trên iPhone để xem tình hình hôm nay, xem doanh thu,
tìm khách, xem lịch và xử lý cảnh báo.

## GIAI ĐOẠN 4 — ỔN ĐỊNH HỆ THỐNG

Thời gian: 5–7 ngày

### Lỗi ưu tiên phải xử lý

- Salon cũ thiếu dữ liệu Manager/SIP.
- Nail Try-On bị timeout.
- Email verification token bị null.
- Các lỗi SMS và callback Twilio.
- Build production bị treo.
- Những lỗi lint có khả năng ảnh hưởng logic hoặc bảo mật.

### Kiểm thử bắt buộc

- Đăng ký mới và đăng nhập lại.
- Quên hoặc mất email đăng nhập.
- Tạo, sửa và hủy lịch.
- Thêm walk-in và đổi trạng thái lịch.
- Gửi SMS.
- Khách đặt lịch từ trang công khai.
- Phân quyền Owner, Admin, Receptionist và Nail Tech.
- Tiếng Anh và tiếng Việt.
- iPhone SE, iPhone Pro Max, iPad và máy tính.

### Điều kiện hoàn thành

- Không còn lỗi P0 hoặc P1.
- Không mất hoặc ghi sai dữ liệu.
- Không có màn hình chết.
- Các thao tác chính phản hồi rõ ràng.
- Production build thành công.

## GIAI ĐOẠN 5 — THỬ NGHIỆM VỚI SALON THẬT

Thời gian: 7–14 ngày

### Chọn nhóm thử nghiệm

- 3 salon.
- Ít nhất một chủ salon lớn tuổi.
- Ít nhất hai tiếp tân ít sử dụng công nghệ.
- Không chọn toàn bộ người quen hoặc người làm kỹ thuật.

### Cách thử

Không hướng dẫn toàn bộ sản phẩm. Chỉ nói: “Đây là phần mềm quản lý lịch. Hãy
thử tạo lịch cho một khách mới.”

Quan sát họ bấm vào đâu đầu tiên, chỗ nào khiến họ dừng lại, từ nào họ không
hiểu, họ có sợ bấm nhầm không, họ có gọi hỗ trợ không và công việc mất bao lâu.

### Chỉ số cần đạt

- 80% người dùng tự hoàn thành năm công việc chính.
- Tạo lịch dưới 60 giây.
- Thêm walk-in dưới 30 giây.
- Không quá một lần cần trợ giúp trong ca đầu tiên.
- Không có sự cố mất dữ liệu.
- Ít nhất hai trong ba salon muốn tiếp tục sử dụng.

## GIAI ĐOẠN 6 — THANH TOÁN VÀ CHÍNH SÁCH TRIAL

Thời gian: 3–5 ngày

### Phải quyết định trước

Sau ngày thứ 14: cho xem dữ liệu nhưng không cho tạo lịch mới; hoặc cho gia hạn
một lần; hoặc yêu cầu chọn gói để tiếp tục.

Khuyến nghị: cho xem dữ liệu nhưng khóa các thao tác tạo mới. Không khóa khách
khỏi dữ liệu của họ.

### Luồng thanh toán

- Gửi nhắc trước khi hết trial 5 ngày, 2 ngày và trong ngày cuối.
- Hiển thị số ngày còn lại trong Dashboard.
- Một nút duy nhất: “Tiếp tục sử dụng NailIQ”.
- Giá thống nhất: 39 CAD/tháng.
- Có hóa đơn và trạng thái thanh toán rõ ràng.
- Xử lý được thẻ thất bại và hủy gói.

### Điều kiện hoàn thành

Một khách thử nghiệm có thể tự thanh toán mà không cần gọi hỗ trợ.

## GIAI ĐOẠN 7 — BÁN CÓ KIỂM SOÁT

Thời gian: 30 ngày đầu

### Phạm vi

- Chỉ nhận 10 salon đầu tiên.
- Không chạy quảng cáo lớn.
- Founder trực tiếp theo dõi onboarding và phản hồi.
- Có kênh hỗ trợ rõ ràng.
- Ghi nhận mọi câu hỏi lặp lại để cải thiện sản phẩm.

### Chỉ số theo dõi

- Số người vào trang chủ.
- Tỷ lệ bấm “Dùng thử”.
- Tỷ lệ hoàn thành đăng ký.
- Tỷ lệ hoàn thành thiết lập salon.
- Tỷ lệ tạo lịch đầu tiên.
- Số salon hoạt động sau 7 ngày.
- Tỷ lệ chuyển từ trial sang trả tiền.
- Số yêu cầu hỗ trợ trên mỗi salon.

### Mục tiêu ban đầu

- 40% người bắt đầu đăng ký hoàn thành tạo salon.
- 70% salon hoàn thành thiết lập.
- 60% salon tạo lịch đầu tiên trong 24 giờ.
- 30% trial chuyển sang trả tiền.
- Dưới hai yêu cầu hỗ trợ mỗi salon trong tuần đầu.

## PHÂN LOẠI ƯU TIÊN

### P0 — Không được bán nếu còn lỗi

- Mất dữ liệu.
- Sai phân quyền.
- Không đăng ký hoặc đăng nhập được.
- Không tạo hoặc quản lý lịch được.
- Thanh toán sai.
- Lộ dữ liệu khách hàng.

### P1 — Phải sửa trước khi bán rộng

- SMS không ổn định.
- Giao diện iPhone bị che hoặc khó bấm.
- Tiếp tân không hiểu luồng chính.
- Trial hoặc giá hiển thị không thống nhất.
- Build/deploy không đáng tin cậy.

### P2 — Có thể sửa trong pilot

- Báo cáo nâng cao.
- Hiệu ứng hình ảnh.
- Tùy chỉnh màu sắc.
- Marketing automation.
- Các tính năng AI không ảnh hưởng vận hành chính.

### P3 — Hoãn lại

- Tính năng “wow” nhưng chưa có bằng chứng khách cần.
- Tùy chỉnh hiếm dùng.
- Tích hợp chưa có khách yêu cầu.

## AI CHỊU TRÁCH NHIỆM VIỆC GÌ

AI có thể rà soát và sửa mã nguồn; thiết kế lại UX/UI; chuẩn bị migration; tạo
test; kiểm tra Preview; đọc logs; chuẩn bị checklist nghiệm thu; phân loại lỗi;
và chuẩn bị báo cáo phát hành.

Chủ sản phẩm phải quyết định chính sách khi hết trial; phạm vi tính năng bán đầu
tiên; salon tham gia thử nghiệm; giá cuối cùng; và thời điểm cho phép phát hành
production.

## VIỆC CẦN LÀM NGAY BÂY GIỜ

Checkpoint điều hành: 30/08/2026.

### Cách ghi bằng chứng

- `LIVE_VERIFIED`: đã kiểm chứng trực tiếp trên production, gồm cả side effect.
- `MERGED_LIVE`: mã đã merge và production đang chạy đúng commit; chưa mặc định
  là luồng nghiệp vụ đã được chứng minh end-to-end.
- `PASS_CI`: test bắt buộc và build trên CI đã xanh.
- `PASS_QA`: đã kiểm chứng bằng dữ liệu synthetic trên môi trường QA tách biệt.
- `PASS_LOCAL`: test có liên quan đã xanh trên máy phát triển.
- `NOT_PROVEN`: đã có mã hoặc cấu hình nhưng chưa đủ bằng chứng end-to-end.
- `BLOCKED`: thiếu môi trường, quyền hoặc quyết định chính sách bắt buộc.

Không dùng `PASS_LOCAL`, `PASS_CI`, Preview hoặc HTTP 200 để tuyên bố một luồng
đã hoạt động trên production.

### Batch đã hoàn thành — P0 Delivery Truth

Mục tiêu: mọi booking đã commit phải hiện thành công; SMS, email và Waitlist phải
có trạng thái giao nhận bền vững, có thể retry/reconcile mà không tạo booking
trùng hoặc gửi trùng.

1. Chuyển phần SMS Delivery Truth còn giá trị từ PR #1277 lên nền `main` hiện
   tại; không làm mất các thay đổi booking #1278–#1290.
2. Bảo đảm tất cả đường gửi SMS đi qua một dispatcher; lưu rõ `queued`, `sent`,
   `delivered`, `suppressed`, `failed` và `unknown`; callback chỉ cập nhật đúng
   attempt/provider receipt tương ứng.
3. Đưa thông báo owner của Waitlist vào outbox bền vững; join/promotion/claim/
   expiry phải idempotent, có retry và không auto-book trùng.
4. Hiển thị Rescue Card cho tiếp tân/chủ khi kênh bị tắt, thiếu cấu hình, failed
   hoặc unknown; cho phép thao tác an toàn, có audit, không tự gọi provider trong
   QA.
5. Kiểm chứng theo thứ tự: focused tests → typecheck/lint → migration rehearsal
   trên Supabase QA disposable → Preview synthetic → CI.

Điều kiện hoàn thành: `PASS_QA` và `PASS_CI`; không gửi SMS/email thật, không tạo
booking thật và không đổi flag salon production trong batch này.

Kết quả ngày 30/08/2026: `PASS_LOCAL + PASS_CI + PASS_QA`. PR #1291 là đường
review duy nhất; Preview synthetic đã chứng minh app đọc đúng Supabase QA, không
tạo booking/Waitlist/SMS attempt/outbox ngoài ý muốn. Dữ liệu synthetic và branch
QA disposable đã được xóa sau khi lưu bằng chứng. Chưa merge hoặc deploy
Production; vì vậy trạng thái production của capability này vẫn là `NOT_PROVEN`.

### Batch đang hoạt động — P0 No-show/Late-cancel/Payment Truth

Mục tiêu: tách rõ và hiển thị đúng năm sự thật độc lập: `card_on_file`,
`fee_approved`, `provider_dispatched`, `provider_receipt` và `reconciled`. Booking
hoặc thao tác no-show không được báo “đã thu” chỉ vì có thẻ hay có approval.

1. Audit read-only toàn bộ đường card-on-file, late-cancel, no-show, charge,
   refund, webhook và reconciliation trên `main` hiện tại.
2. Chuẩn hóa một ledger/idempotency contract; cùng một business event không thể
   tạo hai payment attempts và trạng thái `succeeded` bắt buộc có receipt Square
   khớp tenant/location/account.
3. V1 giữ human approval: không auto-charge. Mọi charge/refund/no-show fee phải
   fail closed khi thiếu quyền, policy snapshot, customer consent/card proof,
   provider mapping hoặc kill switch.
4. Booking/late-cancel/no-show UI hiển thị ngôn ngữ thật: “cần phê duyệt”, “đang
   gửi”, “đã thu”, “thất bại”, “không rõ — cần đối soát”; không suy diễn từ HTTP
   200 hoặc trạng thái nội bộ.
5. Kiểm chứng bằng focused tests, typecheck/lint, migration rehearsal, Supabase QA
   disposable, Preview synthetic và CI; không gọi Square, không thu/refund tiền,
   không gửi thông báo và không dùng dữ liệu salon thật.

Điều kiện hoàn thành: `PASS_QA + PASS_CI`, có bằng chứng duplicate prevention,
receipt gating, tenant/account isolation, reconciliation và rollback/cleanup.
Production vẫn `NOT_PROVEN` cho đến một rollout riêng được phê duyệt.

### Hàng đợi tiếp theo — chỉ làm từng batch

1. **P1 Universal Booking:** một orchestration contract cho cá nhân, nhóm, nhiều
   dịch vụ, add-on, wave, nhân viên, giường/ghế/resource; hỗ trợ mục tiêu đến cùng
   lúc, về cùng lúc, sớm nhất và tối đa công suất; commit nguyên tử, không trùng.
2. **P1 Booking Hub + Receptionist Center:** khách tự xem, đổi giờ, hủy và yêu cầu
   thay đổi trong giới hạn chính sách; nhóm có organizer link; tiếp tân/Admin iPhone
   nhận một Action Center thống nhất cho booking, Waitlist, delivery và payment.
3. **V1.5 AI Brain:** `Assist` cho đề xuất, `Approve` cho hành động trung bình,
   `Autopilot` chỉ cho hành động rủi ro thấp; mọi đề xuất có lý do, độ tin cậy,
   audit, receipt và rollback khi có thể.
4. **Pilot có kiểm soát:** QA matrix đầy đủ rồi rollout theo từng salon/capability;
   đo booking success, duplicate rate, delivery success, recovery time, thời gian
   thao tác của tiếp tân và mức sử dụng self-service.

Không bắt đầu batch sau khi P0 hiện tại chưa đạt điều kiện hoàn thành. Không mở
rộng salon, bật provider, gửi thông báo khách hoặc thu tiền chỉ dựa trên mã đã
merge; mỗi capability phải có rollout gate và bằng chứng production riêng.
