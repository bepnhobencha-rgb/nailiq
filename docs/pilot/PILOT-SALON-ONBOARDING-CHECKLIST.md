# NailIQ — Pilot Salon Onboarding Checklist

**Mục đích:** danh sách BẮT BUỘC hoàn tất cho **từng** tiệm pilot trước khi go-live. Không go-live
khi còn mục chưa tick. Giới hạn pilot: **3–5 tiệm**. Tham chiếu điều kiện kỹ thuật:
[`../audit/PILOT-READINESS-REPORT.md`](../audit/PILOT-READINESS-REPORT.md).

> **Quy tắc bảo mật:** KHÔNG dùng credential (Square token, SMS sender, email) của tiệm này cho
> tiệm khác. Mỗi tiệm cấu hình độc lập.

---

## Salon: ________________________  ·  Ngày onboard: __________  ·  Người phụ trách: __________

### A. Pháp lý & liên hệ
- [ ] Tên tiệm hợp pháp + tên hiển thị.
- [ ] Địa chỉ, số điện thoại liên hệ chính, email.
- [ ] Người đại diện/chủ tiệm + quyền quyết định go-live.

### B. Thương hiệu
- [ ] Logo (đúng tỉ lệ, nền phù hợp).
- [ ] Màu thương hiệu (primary/accent).
- [ ] Domain / booking URL (subdomain nailiq hoặc custom domain).

### C. Dịch vụ & nhân sự
- [ ] Danh sách services: tên, **giá**, **thời lượng**, category.
- [ ] Danh sách staff + skills/dịch vụ mỗi người làm được.
- [ ] Working hours, breaks, days off cho từng staff + tiệm.

### D. Chính sách booking
- [ ] Booking policy (đặt trước bao lâu, giới hạn).
- [ ] Cancellation policy.
- [ ] Lateness policy.
- [ ] No-show policy (có thu card/deposit không).

### E. OTP & liên lạc khách (QUAN TRỌNG — rủi ro vận hành thật)
- [ ] `phone_otp_enabled` — set đúng ý tiệm.
- [ ] **Số điện thoại fallback của tiệm** (`salon_phone`) đã set → tel:// "gọi để đặt" hoạt động.
- [ ] **`email_links_enabled` = BẬT** — kênh OTP thứ 2 khi SMS không tới (bắt buộc nếu A2P chưa duyệt).
- [ ] Email hỗ trợ hợp lệ.
- [ ] **Twilio/A2P hoặc SMS sender đã đăng ký/hợp lệ.** ⚠️ SMS "sent" ≠ "delivered" nếu A2P chưa duyệt — xác nhận trạng thái trước go-live.
- [ ] SMS consent wording đúng (CASL/TCPA).

### F. Thanh toán
- [ ] Square account đã connect (test-connection xanh trong Admin).
- [ ] Square **physical Gift Card** setup (nếu tiệm bán thẻ cứng).
- [ ] Square **eGift Card** setup (nếu tiệm bán thẻ điện tử).
- [ ] No-show card flow (nếu bật) đã kiểm.

### G. Kênh & marketing
- [ ] Website + booking URL hoạt động.
- [ ] Google / Facebook / Instagram booking links.
- [ ] QR code (nếu dùng).

### H. Đào tạo & booking thử
- [ ] Owner + staff training (tạo/sửa/huỷ booking, xem dashboard).
- [ ] **1 booking THỬ** với dữ liệu pilot — **được chủ tiệm cho phép**.
- [ ] Xác minh booking thử **xuất hiện đúng dashboard** của tiệm.
- [ ] **Xoá hoặc đánh dấu rõ** booking thử sau khi kiểm.

### I. Go-live
- [ ] **Go-live approval** — chữ ký/xác nhận của chủ tiệm: ________________
- [ ] **Kế hoạch rollback** đã thống nhất (Vercel Instant Rollback về deploy READY trước; không migration nên rollback code là đủ).
- [ ] **Người hỗ trợ/theo dõi phản hồi** được chỉ định: ________________ (theo dõi Vercel runtime errors + booking thực tế; bất thường → rollback + điều tra).

---

**Ký xác nhận hoàn tất onboarding:** ________________  ·  Ngày: __________
