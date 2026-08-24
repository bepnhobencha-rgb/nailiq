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

## 7. Đồng bộ Google / Outlook / Wix Calendar
- **Quyết định V1 ngày 2026-08-24:** chưa chào bán hoặc mở kết nối mới.
- Kết nối Wix cũ chỉ được giữ để không làm gián đoạn salon đang live.
- Chỉ mở lại khi có provider acceptance trên môi trường non-production, replay/out-of-order proof và kế hoạch migration/rollback cho salon cũ.

## 8. Đồng bộ Square Loyalty / Gift Card
- **Quyết định V1 ngày 2026-08-24:** Square tiếp tục là hệ thống độc lập cho tiền, Loyalty và Gift Card; NailIQ không đồng bộ số dư hoặc giao dịch.
- V1 chỉ hướng dẫn luồng chuyển sang thu tiền/phần cứng Square; không quảng cáo Loyalty/Gift Card sync.
- Chỉ mở Phase 2 sau Square Sandbox E2E đầy đủ, consent binding, refund/reversal/replay proof và quy tắc coexistence với Stripe.

## 9. NailIQ checkout qua Square / Stripe Terminal
- **Quyết định V1 ngày 2026-08-23, xác nhận lại 2026-08-24:** nhân viên hoàn tất dịch vụ trong NailIQ rồi nhập số tiền và thu trực tiếp trong Square; tiền không đi qua NailIQ.
- Phase 2 mới mở nút **Collect payment** từ NailIQ sang Square Terminal, Stripe Terminal hoặc Tap to Pay được nhà cung cấp hỗ trợ.
- Chỉ quảng cáo sau khi có provider parity, exact-amount/reference binding, receipt/replay/refund reconciliation, tenant isolation, hardware/device acceptance và rollback trên môi trường non-production.

---
*Cập nhật khi thêm/bớt mục. Nguồn: các phiên làm việc 2026-06.*
