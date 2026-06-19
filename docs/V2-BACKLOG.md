# NailIQ — Backlog v2 (để dành, làm sau khi có salon trả tiền)

> Những tính năng "wow"/mở rộng đã bàn nhưng cố ý hoãn để không phình scope v1.
> Làm khi: đã có salon trả tiền ổn định, hoặc khi một mục có "trigger" rõ bên dưới.

## 1. Apple Wallet pass cho lịch hẹn  ⭐ (Huy muốn để dành — 2026-06-18)
- Vé hẹn `.pkpass` trên màn khoá điện thoại: tự hiện giờ, tự nhắc, 1 chạm chỉ đường.
- **Cần:** tài khoản Apple Developer (~$99/năm) + chứng chỉ PassKit để ký file.
- **Hiện có thay thế tạm:** email xác nhận đã có "thêm vào lịch" (Google Calendar + .ics).

## 2. Hồ sơ khách không mật khẩu (magic-link)
- Email = chìa khoá vào trang quản lý: đổi/huỷ/đặt lại 1 chạm, lịch sử, ảnh bộ nail cũ.
- Lý do xin email cao cấp kiểu Tesla/Apple. (Link đổi/huỷ cơ bản thì app đã có sẵn.)

## 3. Điểm thưởng + ưu đãi sinh nhật (kiểu Square)
- Tích điểm mỗi lần ghé + ưu đãi sinh nhật tự động.
- **Cần thêm:** ô ngày sinh ở bước thông tin + schema điểm thưởng.

## 4. Ô tick "đồng ý nhận email khuyến mãi" + cột DB lưu consent
- Opt-in marketing (bắt buộc cho khách EU theo GDPR).
- **Cần:** cột `email_marketing_consent_at` (best-effort stamp) + checkbox ở bước 5.
- (Email bắt buộc đã làm; phần consent này tách ra vì cần cột DB.)

## 5. Mở rộng tiền tệ + bỏ "$" cứng ở trang đặt lịch
- Thêm EUR / GBP / MXN (hiện chỉ CAD/USD/VND).
- Sửa chỗ hardcode "$" trong `BookingFlowServicePanel.tsx` → dùng `formatCurrency(salon.currencyCode)`.
- Mặc định tiền tệ theo nước của tiệm.

## 6. Ô chọn quốc gia cho đăng ký/đăng nhập CHỦ TIỆM
- Hiện country picker mới làm cho **khách đặt lịch**; phần đăng ký chủ tiệm vẫn mặc định +1.
- Đăng ký chủ tiệm toàn cầu hiện đã ổn nhờ email/Google (không cần SĐT), nên ưu tiên thấp.

---
*Cập nhật khi thêm/bớt mục. Nguồn: các phiên làm việc 2026-06.*
