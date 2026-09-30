# Phiếu quan sát pilot thật — hai salon Hi-Lite

Dùng cho Giai đoạn 5 của [`../MASTER_PLAN.md`](../MASTER_PLAN.md), **không** dùng
phiếu QA/Preview `day5-human-acceptance-sheet.md` để tự chứng nhận pilot thật.
Phiếu này là mẫu trống; chưa có người thử, ngày đo hay kết quả nào được xác nhận.

## Trước khi bắt đầu

- Cohort: `S1` = Hi-Lite Head Spa; `S2` = Hi-Lite Studio. Quan sát **cả hai**
  địa điểm trong 7–14 ngày thực tế, tính từ ngày bắt đầu được người phụ trách
  xác nhận; không tính lùi từ ngày đã vận hành trước đó.
- Chủ/đại diện từng salon đồng ý cách quan sát, người phụ trách và cách xử lý
  sự cố. Không tự bật tính năng, thay chính sách, tạo booking thử, gọi provider
  hoặc gửi thông báo để lấy số đo. Nếu chỉ thử trên QA synthetic, ghi là QA,
  **không** nhập vào kết quả pilot thật.
- Người quan sát ghi mã `OBS1`, người thử ghi `P1`…; giữ danh tính và sự đồng ý
  ở hồ sơ riêng của salon. Không đưa tên, email, số điện thoại, mã booking,
  ảnh màn hình chứa khách hoặc dữ liệu thanh toán vào repo/bộ chấm.
- Mẫu người thử phải có ít nhất một chủ lớn tuổi, hai tiếp tân ít dùng công
  nghệ, ít nhất một người không thuộc nhóm quen/kỹ thuật, và ít nhất một người
  được quan sát tại mỗi địa điểm. Vai trò trong tài khoản không tự chứng minh
  các đặc điểm này.

## Hồ sơ theo địa điểm — điền riêng cho S1 và S2

Mã salon: `S__` · Mã người quan sát: `OBS__` · Ngày bắt đầu: ______ · Ngày kết
thúc: ______ · Số ngày quan sát thực tế: ______ · Thiết bị/ngôn ngữ: ______

Chủ/đại diện đã đồng ý cách quan sát: Có / Chưa · Người xử lý sự cố: ______

Có mất, ghi sai hoặc nhầm dữ liệu khách/lịch không: Có / Không / Chưa xác minh

Salon muốn tiếp tục sau pilot: Có / Không / Chưa hỏi

Nếu có sự cố dữ liệu/quyền, dừng phép đo và xử lý vận hành trước; không đánh dấu
“Không” chỉ vì chưa có người báo lỗi. Nếu ngày đo, sự cố hay ý kiến tiếp tục
chưa được xác nhận, để trống/null trong bộ chấm — không tự điền PASS.

## Một phiếu cho mỗi người thử

Mã người thử: `P__` · Mã salon: `S__` · Vai trò: Chủ / Tiếp tân

Chủ lớn tuổi: Có / Không / Chưa xác minh · Ít dùng công nghệ: Có / Không / Chưa xác minh

Người quen của nhóm triển khai: Có / Không / Chưa xác minh · Người làm kỹ thuật:
Có / Không / Chưa xác minh · Số lần cần giúp trong ca đầu: ______ / Chưa đo

Người quan sát chỉ nêu: “Đây là phần mềm quản lý lịch. Hãy thử tạo lịch cho một
khách mới.” Không hướng dẫn các bước trong lần đo độc lập. Chỉ quan sát công
việc thường ngày đã được salon cho phép; không ép nhân viên thao tác lên một
khách thật chỉ để hoàn thành phiếu. Nếu một việc không xuất hiện an toàn trong
cửa sổ pilot, ghi **chưa đo**, không dựng dữ liệu hoặc chấm thành công.

| Việc | Hoàn thành? | Tự làm, không được nhắc bước? | Thời gian giây | Điểm dừng/khó hiểu, không ghi PII |
|---|---|---|---:|---|
| Xem lịch hôm nay (`view_today`) | Có / Không / Chưa đo | Có / Không / Chưa đo | ___ | ___ |
| Tạo hẹn (`create_booking`) | Có / Không / Chưa đo | Có / Không / Chưa đo | ___ | ___ |
| Thêm walk-in (`add_walkin`) | Có / Không / Chưa đo | Có / Không / Chưa đo | ___ | ___ |
| Đổi trạng thái (`change_status`) | Có / Không / Chưa đo | Có / Không / Chưa đo | ___ | ___ |
| Tìm khách (`find_customer`) | Có / Không / Chưa đo | Có / Không / Chưa đo | ___ | ___ |

Đo từ lúc người thử bắt đầu việc đến khi NailIQ xác nhận kết quả đúng. Nếu phải
giúp, ghi `independent=false`; nếu không hoàn thành, ghi `completed=false`.
Không sửa số đo để đạt ngưỡng. Với đúng ba người thử tối thiểu, ≥80% nghĩa là
**cả ba** phải tự hoàn thành năm việc, tạo hẹn dưới 60 giây và walk-in dưới 30
giây. Mỗi người cần giúp không quá một lần trong ca đầu.

## Tổng hợp và kết luận

Chỉ nhập **mã và số đo đã ẩn danh** vào
`scripts/qa/evaluate-masterplan-pilot.ts`. `null` nghĩa là chưa có bằng chứng;
không dùng `false` thay cho “chưa hỏi”. Tệp mẫu synthetic chỉ kiểm thử công cụ,
không phải kết quả pilot. Kết luận chỉ là `PASS` khi hai salon đủ 7–14 ngày,
đủ thành phần người thử, ≥80% cùng đạt năm việc và hai ngưỡng thời gian, không
quá một lần cần giúp ở ca đầu, không mất dữ liệu và **cả hai** salon muốn tiếp
tục. Bất kỳ mục thiếu bằng chứng nào là `NOT PROVEN`; sự cố mất dữ liệu hoặc
ngưỡng đã đo không đạt là `FAIL`.

Tệp `scripts/qa/fixtures/masterplan-pilot-human-blank.json` là mẫu nhập trống
cho đúng S1/S2, **không phải bằng chứng**. `OBS1` chỉ là mã giữ chỗ; hãy sao
chép mẫu thành tệp riêng, thay mã bằng mã người quan sát thực tế và chỉ điền
số đo sau khi đã đối chiếu phiếu gốc. Không đưa hồ sơ nhận dạng, dữ liệu khách
hoặc tệp pilot thật có thể tái nhận dạng vào Git. Chạy mẫu trống qua bộ chấm
phải trả `NOT PROVEN`; không dùng việc mẫu được parse thành công làm cổng phát
hành hoặc khởi động pilot.

P1-01 (SMS/callback/receipt thật) là cổng vận hành riêng; pilot UI không được
dùng để tuyên bố thông báo đã giao thành công. Không mở cohort bán hàng 10
salon chỉ vì phiếu này được điền.
