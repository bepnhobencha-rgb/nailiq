# QA — Dashboard Receptionist Center

**Ngày:** 2026-05-30
**Build test:** bản deploy mới (sau fix React #418)
**Ngôn ngữ UI:** VI (kiểm chéo EN/VI)
**Phương pháp:** thao tác thực qua trình duyệt; **không gây side-effect** (không lưu sửa, không hủy, không submit thật).
**Phạm vi:** Dashboard Receptionist Center + Walk-in/Queue form (gộp 2 phiên test).

> ⚠️ **Quan trọng — lệch deploy:** Một số lỗi dưới đây **đã được fix ở nhánh local nhưng CHƯA push/deploy** (các lần push bị chặn, chờ phê duyệt). QA chạy trên build **deploy** nên vẫn thấy hành vi cũ. Xem cột **Trạng thái fix**. Cần deploy rồi re-test để đóng.

---

## ✅ PASS — hoạt động tốt

| Khu vực | Kết quả |
|---|---|
| 3 chế độ xem Ngày / Tuần / Tháng | Chuyển đúng, dữ liệu khớp |
| Date tabs Hôm qua / Hôm nay / Ngày mai | Đổi dữ liệu đúng; quá khứ = xanh lá, tương lai = xanh dương |
| Nút "Hiện tại" | Về hôm nay OK |
| 3 mức mật độ Đơn giản / Cân bằng / Nâng cao | Tăng dần chi tiết (tên → +dịch vụ → +giờ/giá) |
| Nút "Cơ bản" (thu gọn/mở header) | OK |
| Stat cards (Đang chờ / Phục vụ / Sắp tới / Quá giờ / Trống kế tiếp) | Hiển thị đúng |
| Group bookings — dropdown chỗ, phân đợt (ĐỢT 1), "Sao chép link nhóm" | OK, feedback "✓ Đã sao chép!" |
| Modal chi tiết lịch hẹn | Đầy đủ; **render nút theo trạng thái** (Hoàn thành → chỉ xem; Đã xác nhận → Sửa / Bắt đầu phục vụ / Hủy) |
| Nút "Hiện số / Ẩn số" SĐT | Toggle mask đúng — privacy tốt |
| Form "Sửa booking" | Mở đầy đủ (Giờ/Thợ/Dịch vụ), tính "kết thúc lúc…/giá" động |
| Sidebar (Bảng Live / Hàng chờ / Lịch / Khách hàng / Cài đặt) | Điều hướng OK |
| Toggle EN/VI | Dịch nhất quán |
| Realtime | Party thứ 3 xuất hiện đúng (2 → 3 booking nhóm) |
| Console | Sạch, 0 lỗi suốt phiên |

---

## 🔧 CẦN FIX / CƠ HỘI CẢI THIỆN

| # | Mức | Khu vực | Mô tả | Trạng thái fix |
|---|---|---|---|---|
| 1 | 🟠 TB | Walk-in form | Nghi: submit tên rỗng vẫn POST + hiện đồng thời "lỗi" & "✓ Hoàn tác" | **ĐÃ HARDENING (local, chưa deploy)** — nhánh `fix/walkin-validation-submit-safety` commit `d868c37`. Điều tra: client (`runSubmit`) **và** server (`addWalkinToQueue` → `fail("invalid_name")`) đã chặn tên rỗng/whitespace từ trước → **không tạo được entry rỗng**. "✓ Hoàn tác 0s" thực ra là node `UndoToast` **luôn mount, ẩn khi idle** (aria-hidden/inert) — KHÔNG phải toast thành công thật. Gap thật = double-submit chưa chặn đồng bộ. Đã thêm: `submittingRef` chặn double-submit, trả focus về ô lỗi, `aria-disabled` nút khi thiếu trường, bỏ `method="post"`. Test: queue.spec.ts 5/5. |
| 2 | 🟢 Thấp | Lưới Ngày | Click ô giờ/thợ trống không mở form tạo hẹn nhanh (phải dùng "+ Walk-in") | **MỞ** — cơ hội UX (click-to-create). Chưa làm. Không phải lỗi chặn. |
| 3 | 🟢 Thấp | Month view | "[removed]" hiển thị thô + casing "HUY" (caps-lock) | **ĐÃ XỬ LÝ (local, chưa deploy)** — helper `displayCustomerName`: "[removed]" → "Khách đã xoá", làm mềm ALL-CAPS → title case. Lưu ý review: chưa áp dụng ở **mọi** nơi render tên (toast undo, nhãn conflict, hàng chờ…) — xem mục "Ghi chú". |
| 4 | 🟢 Thấp | Day grid | Cắt chữ tên "Liam (O…", "Gue…" | **ĐÃ CHỈNH (local, chưa deploy)** — tên wrap 2 dòng (`line-clamp-2` + `overflow-wrap:normal`), không cắt giữa từ; tên đầy đủ ở tooltip + drawer. |
| 5 | 🟢 Thấp | Khách quen | "$0.00 tổng" cho khách đã đến 2 lần | **MỞ — cần xác minh** logic lifetime value (data/server). Chưa điều tra. |

---

## ↩️ ĐÃ ĐÍNH CHÍNH — không phải bug

- **Banner "Mất kết nối" + lẫn ngôn ngữ:** không tái hiện trên build mới (gắn với React #418 đã fix).
- **"Sẵn sàng lúc 11:40 PM" trong form:** đúng (giờ thực ~11:10 PM).
- **Card "Đang chờ" click không phản hồi:** hợp lý (giá trị 0, hàng chờ rỗng).
- **Booking "Hoàn thành" không có nút Sửa/Hủy:** đúng thiết kế (terminal state — không sửa lịch đã xong).
- **Clipboard read timeout khi test "Sao chép link nhóm":** giới hạn quyền clipboard trong môi trường automation (cần focus/gesture) — không phải lỗi app; nút đã hiện feedback "✓ Đã sao chép!".

---

## 📝 Ghi chú

- **Lệch deploy:** các nhánh fix local (walk-in safety, `displayCustomerName`, wrap tên, color-coding / check-in / "+ Walk-in" CTA / KPI…) **chưa push/deploy**. Cần deploy rồi **re-test #1 / #3 / #4** để đóng.
- **#3 — áp dụng chưa nhất quán** (từ review code): `displayCustomerName` mới dùng ở drawer + grid + Month/Week + TV; **chưa** dùng ở toast undo, nhãn conflict, hàng chờ / QueueEntryCard, hộp xác nhận restore → "[removed]" / caps-lock vẫn lọt ở các bề mặt đó. Nên gom format về một tầng để khỏi sót.
- **#1 — follow-up tùy chọn:** node `UndoToast` khi idle vẫn render "✓ … 0s" (ẩn). Có thể unmount hẳn khi idle / ẩn chip "Ns" lúc 0s để dứt điểm artifact bạn thấy trong devtools.

---

## Bảng tổng hợp

| Trạng thái | Số mục |
|---|---|
| ✅ PASS | 14 khu vực |
| 🔧 Cần fix — đã có fix local (chưa deploy) | #1, #3, #4 |
| 🔧 Cần fix — còn mở | #2 (UX), #5 (xác minh data) |
| ↩️ Đã đính chính | 5 mục |

**Tổng kết:** Dashboard ở trạng thái **tốt & ổn định** sau fix #418. Việc còn lại chủ yếu là **deploy các fix local** (#1/#3/#4) + polish (#2) + xác minh data (#5).
