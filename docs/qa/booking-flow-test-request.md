# Test request — Luồng book hẹn của khách (chạy tự động bằng Cowork)

> **Cách dùng:** mở Cowork (có Claude in Chrome) và dán nguyên khối "PROMPT" bên dưới,
> hoặc nói "chạy booking-flow-test-request". Cowork sẽ tự đi hết luồng, chụp màn hình
> desktop + mobile, soi từng form/thông báo, rồi xuất report vào `docs/qa/`.
>
> **Mục tiêu:** thay cho việc Huy bấm tay từng bước — nhanh hơn, không sót form,
> không quên mobile. Tìm lỗi để sửa, KHÔNG đụng dữ liệu khách thật.

---

## ⚠️ Ràng buộc an toàn (đọc trước, áp dụng mọi lúc)

1. **TUYỆT ĐỐI KHÔNG bấm nút cuối "Đặt lịch / Confirm / Submit" trên tenant thật**
   (Hi-Lite, salon khách). Test tới ngay TRƯỚC nút xác nhận thì DỪNG, chụp, không gửi.
   Chỉ được submit thật khi test trên **salon test** (slug `e2e-*` / tên `E2E *`) với
   SĐT giả vùng **555** (vd +1 604 555 0123) rồi dọn sau.
2. **Không gửi SMS/email cho số/khách thật.** Nếu phải submit để xem màn success →
   chỉ trên salon test + số 555.
3. Đây là **luồng ra tiền (revenue path)** → nếu phát hiện lỗi chặn, báo NGAY ở đầu report.
4. Theo `docs/qa/README.md` mục 1: **hard-refresh + đúng giờ tiệm + loại flake** trước khi
   kết luận là bug.

---

## PROMPT (dán khối này vào Cowork)

```
Chạy QA luồng book hẹn khách của NailIQ theo docs/qa/booking-flow-test-request.md.

SURFACE cần test (hỏi tôi nếu chưa rõ): {điền URL, vd https://nailiq.ca/<slug> hoặc
embed trên hiliteheadspa.com}.

Yêu cầu:
1. Mở bằng Claude in Chrome. Test ở 2 kích thước:
   - Desktop ~1280px
   - Mobile ~390px (iPhone). Chụp màn hình MỖI bước ở cả 2.
2. Trước khi bắt đầu: hard-refresh (Cmd/Ctrl-Shift-R). Ghi lại giờ TIỆM hiện tại
   (theo timezone salon, KHÔNG phải giờ máy) để đối chiếu phần ngày/giờ.
3. Đi tuần tự hết các bước (mục "Checklist từng bước" bên dưới). Mỗi bước:
   - Chụp màn hình.
   - Soi: nhãn/label, placeholder, nút, thông báo lỗi khi bỏ trống / nhập sai,
     responsive (có bị tràn/che/cắt chữ không), dark mode nếu có.
   - Thử 1 input HỢP LỆ và 1 input SAI (vd email thiếu @, phone thiếu số) để xem
     validation + câu báo lỗi (EN và VI nếu đổi ngôn ngữ được).
4. DỪNG ngay trước nút xác nhận cuối trên tenant thật (xem ràng buộc an toàn).
5. Xuất report tiếng Việt vào docs/qa/booking-flow-<surface>-<YYYY-MM-DD>.md theo
   format mục "Mẫu report" — phân loại 🔴/🟠/🟢, kèm bước tái hiện + ảnh.
6. Với mỗi lỗi: đã loại 3 bẫy false-positive (bundle cũ / lệch timezone / flake) chưa?
```

---

## Checklist từng bước (Cowork soi đúng những điểm này)

**B1 — Cổng vào / chọn Cá nhân vs Nhóm**
- Nút "Cá nhân" và "Nhóm" hiển thị rõ, bấm được, nhảy đúng nhánh.
- Ô SĐT: mã quốc gia mặc định đúng theo location salon (US→US, Canada→CA…), cụm
  nước láng giềng đúng, ô country KHÔNG che ô nhập số, có +mã sẵn ở đầu.
- "Welcome back" tự điền tên khi nhập SĐT khách cũ (nếu có).

**B2 — Chọn dịch vụ**
- Giá hiển thị đúng đơn vị tiền theo nước salon (USD/CAD/EUR…), không hardcode `$`.
- Combo/đơn lẻ chọn được; tổng tiền + tổng thời lượng cộng đúng.
- Tiêu đề modal đúng (không phải nhãn sai như "before you book").

**B3 — Chọn thợ**
- "Bất kỳ thợ nào" + từng thợ; avatar/tên đúng; chọn được.

**B4 — Chọn ngày (lịch mới)**
- Lịch mở ở TUẦN HIỆN TẠI, không có tuần trống lỗng phía trên.
- Ngày quá khứ trong tuần: mờ + không bấm được. Mũi tên "‹" về tháng trước: khóa.
- Chấm 3 màu đúng số chỗ: 🟢 nhiều / 🟡 sắp đầy / 🔴 hết chỗ (đỏ KHÔNG bấm được).
- Nút "Ngày gần nhất còn chỗ" nhảy đúng ngày sớm nhất còn slot.

**B5 — Chọn giờ**
- Slot khớp giờ mở cửa tiệm (giờ TIỆM); ngày hết chỗ không lọt vào đây.
- Slot đã qua trong hôm nay bị ẩn/khóa.

**B6 — Thông tin liên hệ**
- Tên (bắt buộc), Email (bắt buộc — báo lỗi nếu bỏ trống/sai), SĐT.
- Bỏ trống từng ô → câu báo lỗi rõ ràng, đúng ngôn ngữ.

**B7 — Xác nhận / Tóm tắt**
- Tóm tắt đúng: dịch vụ, thợ, ngày/giờ (giờ tiệm), giá, liên hệ.
- → DỪNG trước nút xác nhận trên tenant thật. (Chỉ submit nếu salon test + số 555,
  rồi xem màn success + nội dung thông báo gửi khách.)

**Xuyên suốt**
- Mobile 390px: không tràn ngang, nút đủ to (≥44px), không che nhau.
- Đổi ngôn ngữ EN↔VI: chữ dịch đủ, không lòi key thô (vd `calendarSoonest`).
- Không có lỗi đỏ ở Console (Cowork đọc console khi nghi ngờ).

---

## Mẫu report (Cowork ghi ra file)

```
# QA Booking — <surface> — <YYYY-MM-DD>
Build/commit test: <nếu biết> · Giờ tiệm lúc test: <...> · UI: VI/EN · Thiết bị: desktop+mobile

## 🔴 Lỗi chặn (phải fix)
- [Khu vực] Mô tả · Bước tái hiện · Ảnh · (đã hard-refresh + đúng giờ tiệm)

## 🟠 Lỗi trung bình
...

## 🟢 Cơ hội cải thiện (UX/wow)
...

## ✅ Đã kiểm tra OK
- B1 cổng vào · B2 dịch vụ · ...
```
```

---

## Tự động hoá (tuỳ chọn)

- Có thể đặt **scheduled task** chạy test request này định kỳ (vd mỗi sáng) trên 1 salon
  test, để bắt regression sớm — báo Huy nếu muốn bật.
