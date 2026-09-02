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

## EXECUTION QUEUE — 30/08/2026

### P0 — No-show / Late-cancel / Payment Truth

Trạng thái: `PASS_LOCAL + PASS_QA`; Production `NOT_PROVEN`.

- [x] Hủy lịch đã commit luôn trả success; khách không bị thúc đẩy retry vì bước phí.
- [x] Public web và Voice AI không gọi payment provider sau khi hủy.
- [x] Phí trễ hiển thị trung thực là `approval_required`: chưa thu, chờ Owner/Admin duyệt.
- [x] No-show charge chỉ được vào payment ledger khi khớp exact immutable approval receipt.
- [x] Service role không được ghi trực tiếp review/receipt; chỉ đi qua RPC có kiểm soát.
- [x] Không chấp nhận trạng thái `succeeded` nếu ledger chưa succeeded hoặc thiếu provider receipt.
- [x] Late-cancel charge fail-closed cho đến khi có workflow approval receipt riêng.
- [x] Full unit, typecheck, focused lint, production build và Supabase QA synthetic đều PASS.
- [ ] CI Preview PASS.
- [ ] Review/merge có phê duyệt.
- [ ] Migration Production + Production verification có phê duyệt riêng.

### Thứ tự tiếp theo sau P0

1. Universal Booking Truth: individual, group, wave, multi-service tuần tự/song song,
   resource/staff/bed/time và card policy dùng cùng orchestrator contract.
2. Customer Booking Hub: xem, đổi lịch, hủy, RSVP và waitlist bằng capability link;
   mọi committed action luôn có trạng thái rõ ràng.
3. AI Revenue & Rescue: AI chỉ đề xuất/chuẩn bị; hành động có tiền, gửi thông báo hoặc
   thay đổi lịch phải qua policy, idempotency, approval và delivery truth.
4. Pilot certification: synthetic trước, sau đó salon allowlist; tách rõ
   `implemented`, `tested`, `production-proven` và `not proven`.

### Controlled pilot — TurnIQ Trust Engine

Trạng thái: `M4O_CHECKIN_QR_LIFECYCLE_UX_LOCAL`; engine, private ledger, Receptionist
shadow/replay, atomic single-service commands, authenticated Server Actions,
role-safe projections, trusted server snapshot, Live Board, atomic
Confirm/Override và Fairness Receipt đã được kiểm tra local. Staff
check-in/break/return, Start/Complete, privacy-safe Staff View và Owner Exception
Inbox đã được nối vào cùng atomic command boundary. Kỹ thuật viên có thể tạo
dispute chỉ từ Fairness Receipt của chính mình. Người bị skip thấy lý do riêng tư
và chỉ có thể yêu cầu xem lại khi chính họ có trong persisted skip trace;
Owner/Admin có thể acknowledge, resolve hoặc dismiss với lý do, command receipt
và immutable event. Chưa commit, chưa
áp QA/Production, chưa pilot; mọi salon đều
`OFF`.

M3C chỉ nhận booking/command/device IDs từ browser; policy, ca làm, kỹ năng,
resource, appointment gap, actor và đề xuất đều được server tự lấy lại. Live
Board không hiển thị PII hoặc tiền của thợ khác và refresh theo Receptionist
Center. Booking đã có thợ, group/sequence, booking_addons chưa khớp ledger hoặc
resource alternatives đều fail-closed. M3D còn đóng băng exact shift/catalog/
capacity snapshot và tái kiểm tra skill/gap/resource trong cùng transaction;
mọi drift đều rollback và yêu cầu refresh. M3E giữ retry bằng cùng command ID,
không biến refresh lỗi thành lời nhắc làm lại một lệnh đã commit. M3F tạo dispute
và owner exception trong cùng transaction; resolve dispute cũng đóng exception
liên kết mà không sửa lịch sử gốc. M3G mở “Why not me?” bằng deterministic copy,
own-skip proof và một quiet owner exception; không lộ tiền hoặc internal trace của
đồng nghiệp, không sửa quyết định gốc. Refusal supervised đã phân biệt khách từ
chối (không phạt), bệnh/khẩn cấp được duyệt (giữ vị trí + tạm giữ) và từ chối
không lý do duyệt (xuống cuối hàng); cùng command receipt + immutable event,
không tự đổi booking. Redo/repair giờ là assignment mới liên kết assignment gốc
đã hoàn tất; category lấy rule tính lượt và opportunity credit từ đúng policy
version của salon, thiếu rule thì giữ nguyên và tạo owner exception. Completion
giữ business revenue riêng, cập nhật lượt/credit độc lập và chặn đường completion
cũ cho redo. Swap trước dịch vụ giờ cần hai thợ tự consent rồi Front Desk mới
apply; assignment không thể Start khi swap còn mở. Owner/Admin có thể sửa người
thực sự làm sau completion: lượt/credit chuyển atomically, receipt gốc và business
revenue không bị viết lại, correction history là append-only. Pure M4A giờ giải
simultaneous group 2–12 người như một complete constrained plan, không greedy;
requested-tech, appointment safety, wait, fairness và stable tie-break theo đúng
objective order, staff/resource không trùng và ETA là range bảo thủ. Search không
chứng minh được optimal complete plan thì fail-closed. M4B đã thêm authoritative
group-plan ledger: recommendation không sửa booking; confirm khóa và tái kiểm tra
toàn bộ policy/group/staff/shift/skill/gap/resource rồi mới commit cả nhóm trong
một transaction, tạo từng Fairness Receipt và replay command không trùng. Một
member stale sẽ rollback toàn nhóm. M4C đã nối M4A→M4B bằng Server Action chỉ
nhận identifier: server tải lại group/policy/staff/shift/skill/resource/capacity,
chạy matcher, ghi plan, xác nhận atomically và trả desk projection không PII hay
peer money. Retry trả receipt đã commit trước mutable reload; lịch bị dời hoặc
resource nhiều hơn ledger hỗ trợ đều fail-closed. M4D đã thêm Group card ở
Receptionist Center: server trả queue không PII, tiếp tân tạo plan một chạm,
xem toàn bộ thợ/service/resource/ETA và xác nhận cả nhóm atomically; offline,
partial assignment, mixed start hoặc stale đều dừng rõ ràng, committed success
không biến thành retry vì refresh lỗi. Pure M4E đã bổ sung ba timing intent:
đến cùng lúc, về cùng lúc và smart wave; engine cho phép tái sử dụng thợ/resource
chỉ sau khi block trước kết thúc, giữ requested-tech/gap/fairness và luôn ghi rõ
simulation không đổi booking. Search vượt giới hạn hoặc không đủ an toàn đều
M4F đã đưa ba timing intent vào khu vực “What if?” của Receptionist Center:
một lần đọc snapshot server để so sánh cả ba, chỉ trả giờ/thợ/resource/ETA,
không trả peer money/PII/internal trace. Offline chỉ giữ kết quả gần nhất để xem.
M4G đã thêm hợp đồng database local để persist một timing simulation vào đúng
group ledger hiện có mà chưa sửa booking; khi confirm, toàn bộ member được khóa,
đối chiếu fingerprint cũ, chuyển wave và đi qua lại M4B confirmation/Fairness
Receipt trong cùng transaction. Một member stale hoặc conflict sẽ rollback cả
nhóm. M4H đã nối supervised Apply hai bước: tiếp tân chọn một simulation để lưu
kế hoạch xem trước, server tải lại truth và tính lại đúng snapshot/UUID/SHA-256;
sau đó một nút riêng mới áp dụng và xác nhận toàn nhóm với expected state
version. Browser không gửi thợ/resource/fairness/PII/internal trace; simulation
quá 5 phút hoặc bất kỳ drift nào đều fail-closed. Retry dùng lại command ID và
receipt đã commit thắng refresh lỗi. Còn thiếu in-progress multi-tech handoff,
M4I đã chạy trực tiếp bằng trình duyệt với fixture in-memory cho bốn nhánh:
happy path, stale state, committed-success/read-back failure và offline. Route
test cần test flag và loopback host, không dùng database/provider; đây chưa phải
QA/Preview hay pilot. Còn thiếu in-progress multi-tech handoff, realtime push,
UI tạo policy version, offline mutation hoặc pilot. M4J đã thêm contract ETA
khách hàng pure/deterministic: khoảng chờ làm tròn bảo thủ, khoảng cả nhóm,
last-known khi offline, stale thì bỏ ETA và đo accuracy không PII. M4K đã nối
contract này vào status capability hiện có: token phải hợp lệ trước khi đọc
ledger, feature cần salon + platform cùng ON, mọi query theo salon, ETA lỗi thì
booking status vẫn thành công. Khách đơn thấy khoảng riêng; khách nhóm thấy thêm
khoảng cả nhóm bắt đầu. Mạng lỗi giữ booking truth gần nhất nhưng ETA quá hạn sẽ
bị ẩn. M4K chỉ local, chưa QA/Preview hoặc customer-proven.
M4L đã thêm intake receipt QR/kiosk pure và PII-free cho khách có hẹn, walk-in,
nhóm 1–12 người và yêu cầu thợ do khách tự chọn. Receipt chỉ chạy shadow,
định tuyến rõ sang single engine, group optimizer, requested-tech validation
hoặc identity match; không tạo booking hay phân thợ. Offline bị chặn rõ ràng.
ETA accuracy observation chỉ chứa fingerprint/khoảng lệch, không chứa tenant,
booking, khách, thợ hay tiền. Demo loopback PASS desktop + mobile cho 5 tình
huống; chưa có public capability/idempotent server receipt, migration, QA hoặc
pilot.
M4M/M4N đã thêm capability ngắn hạn chỉ lưu hash, receipt shadow append-only,
exact-once replay, rate limit, tenant/ACL boundary, action cấp/thu hồi QR cho
Front Desk đã xác thực và trang check-in công khai; tất cả vẫn Preview/local và
không sửa booking. M4O hoàn thiện vòng đời QR ở local: không thể đổi QR active
âm thầm, có countdown/hết hạn/thu hồi/in song ngữ, tự nhận biết offline, lỗi
Anh/Việt theo nguyên nhân và chuyển focus accessibility. Browser desktop/mobile
và WCAG A/AA đều PASS; chưa QA/Preview/Production hay salon-proven.

TurnIQ là hệ thống đề xuất lượt thợ có giải thích cho appointment và walk-in.
TurnIQ không thay thế booking, POS, payroll hoặc quyết định chính sách của chủ
salon. Engine V1 phải deterministic; AI chỉ giải thích, không chấm điểm công
bằng bằng mô hình hộp đen.

Thứ tự triển khai bắt buộc:

1. M0 — contracts, reason codes, Salon A synthetic fixtures, security/concurrency
   boundary; không thay đổi live behavior.
2. M1 — pure single-customer engine và additive tenant-safe ledger trên local/QA;
   feature flag `turniq_trust_engine_enabled` mặc định `false`.
3. M2 — shadow/replay; chỉ so sánh đề xuất với thao tác thật, không điều khiển
   booking.
4. M3 — supervised online atomic flow và Fairness Receipt.
5. M4 — constrained group matching và customer ETA.
6. M5 — đúng một Primary Offline Device; thiết bị offline khác chỉ đọc.
7. M6 — pilot hardening, rollback rehearsal và 60-second seeded demo.

TurnIQ không được làm chậm hoặc thay thế P0 Booking/Payment Truth. Không được
enable salon, chạy Production migration hoặc gọi provider trong các mốc xây
dựng. Tài liệu sản phẩm authoritative:

- `docs/TURNIQ_V1_PRD.md`
- `docs/TURNIQ_WOW_RESEARCH.md`
- `docs/CODEX_TURNIQ_MASTER_REQUEST.md`

## AI CHỊU TRÁCH NHIỆM VIỆC GÌ

AI có thể rà soát và sửa mã nguồn; thiết kế lại UX/UI; chuẩn bị migration; tạo
test; kiểm tra Preview; đọc logs; chuẩn bị checklist nghiệm thu; phân loại lỗi;
và chuẩn bị báo cáo phát hành.

Chủ sản phẩm phải quyết định chính sách khi hết trial; phạm vi tính năng bán đầu
tiên; salon tham gia thử nghiệm; giá cuối cùng; và thời điểm cho phép phát hành
production.

## VIỆC CẦN LÀM NGAY BÂY GIỜ

1. Kết nối lại quyền Supabase để có thể áp dụng và xác minh migration.
2. Tạo Vercel Preview từ nhánh hiện tại.
3. Kiểm tra hành trình đăng ký hoàn chỉnh.
4. Mở Preview trên iPhone thật.
5. Sau khi bốn bước trên đạt, tiếp tục thiết kế sâu màn hình Front Desk.

Không bắt đầu quảng cáo hoặc nhận nhiều salon trước khi hoàn thành năm bước này.
### TurnIQ M4M — QR/kiosk server trust boundary (local only)

- [x] Hash-only, short-lived customer check-in capabilities
- [x] Append-only PII-free shadow intake receipt with exact-once replay
- [x] Tenant/service/booking/staff revalidation in a service-role-only RPC
- [x] Same-origin, bounded-body, durable IP + capability rate limits
- [ ] Apply migration to disposable QA and run SQL tenant/replay tests
- [x] Connect an authenticated Preview/local issuance action and public check-in surface
- [ ] Production enablement (explicitly out of scope; feature remains OFF)

### TurnIQ M4N — authenticated QR issuance and revocation (local only)

- [x] Real-member Owner/Admin/Senior/Receptionist Server Action
- [x] Explicit salon + platform TurnIQ gate and Preview/local runtime gate
- [x] One-booking QR and bounded walk-in kiosk QR
- [x] Fragment-only raw bearer; hash-only server storage
- [x] Same-salon irreversible revoke with idempotent retry
- [x] Front-desk QR manager and public shadow check-in page
- [x] SQL tenant/ACL/revoke fixture and local capability browser story
- [ ] Disposable QA migration and Preview verification
- [ ] Any live salon enablement or operational booking/assignment mutation

### TurnIQ M4O — QR lifecycle, bilingual resilience and accessibility (local only)

- [x] Active QR countdown, explicit expiry, print view and irreversible revoke feedback
- [x] Prevent silent QR orphaning when type or appointment changes
- [x] Bilingual customer success/error truth and live online/offline detection
- [x] Focus management and WCAG A/AA browser checks on desktop and mobile
- [x] No new schema, provider, booking, assignment or notification path
- [ ] Disposable QA migration and Preview verification
- [ ] Any live salon enablement or operational booking/assignment mutation

### TurnIQ M4P — disposable QA verification

- [x] Confirm QA branch `osdqutwunokiielbairj` is present and healthy
- [x] Confirm QA migration prefix and required schema/column prerequisites
- [x] Confirm no partial TurnIQ schema and zero TurnIQ-enabled QA salons
- [x] Record pre-migration advisor baseline for later diff
- [x] Correct rollout unit from one isolated migration to the ordered 13-migration chain
- [x] Apply the ordered 13 migrations to disposable QA only
- [x] Run all nine transaction-wrapped QA fixtures; verify zero synthetic residue
- [x] Verify 20/20 tables use RLS + FORCE RLS and browser table/RPC grants stay denied
- [x] Diff advisors: zero new TurnIQ WARN/ERROR; only private-table/index INFO notices
- [x] Keep platform and every QA salon TurnIQ flag OFF
- [x] Configure and verify Vercel Preview with all outbound/provider switches OFF
- [ ] Create/review a PR and run authenticated synthetic TurnIQ UI scenarios
- [ ] Merge, Production migration, or live-salon enablement (explicit approval only)
