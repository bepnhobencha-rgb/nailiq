# NailIQ — Pilot Salon Onboarding Checklist

**Mục đích:** danh sách BẮT BUỘC hoàn tất cho **từng** tiệm pilot trước khi go-live. Không go-live
khi còn mục chưa tick. Cohort nghiệm thu theo `docs/MASTER_PLAN.md`: **2 salon, 7–14 ngày**;
đừng tính tenant QA hoặc bản sao là salon thật. Tham chiếu điều kiện kỹ thuật:
[`../audit/PILOT-READINESS-REPORT.md`](../audit/PILOT-READINESS-REPORT.md).

> **Quy tắc bảo mật:** KHÔNG dùng credential (Square token, SMS sender, email) của tiệm này cho
> tiệm khác. Mỗi tiệm cấu hình độc lập.
>
> **Ranh giới thử nghiệm:** QA synthetic/Preview không thay cho phép đo người mới tại salon thật.
> Không tạo booking, gọi provider hoặc gửi thông báo thật chỉ để tick checklist nếu chưa được
> chủ salon cụ thể duyệt kịch bản và người nhận.

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
- [ ] Kênh email fallback/OTP đã được kiểm chứng thực tế và được chủ tiệm đồng ý; không chỉ bật
      `email_links_enabled` rồi mặc định khách sẽ nhận được email.
- [ ] Email hỗ trợ hợp lệ.
- [ ] **Twilio/A2P hoặc SMS sender đã đăng ký/hợp lệ và có receipt giao nhận.** ⚠️ Provider
      `accepted` ≠ `delivered`; CI/Preview xanh cũng không chứng minh SMS đến máy khách.
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

### H. Nghiệm thu người mới & booking thử
- [ ] Có ít nhất một chủ lớn tuổi và hai tiếp tân ít dùng công nghệ trong cohort hai salon;
      không chỉ chọn người quen hoặc người làm kỹ thuật.
- [ ] Quan sát không hướng dẫn năm việc: xem lịch, tạo hẹn, thêm walk-in, đổi trạng thái và tìm
      khách. Ghi thời gian và số lần cần giúp vào `docs/qa/masterplan-two-salon-human-observation-sheet.md`;
      không thay số đo người thật bằng automation.
- [ ] **Booking THỬ** chỉ được tạo nếu chủ tiệm duyệt rõ kịch bản, người nhận và kênh liên lạc;
      ưu tiên salon synthetic QA khi chỉ kiểm chức năng.
- [ ] Nếu đã được phép tạo booking thử trên salon thật, xác minh đúng dashboard, đánh dấu rõ
      là thử nghiệm và xử lý sau kiểm theo phương án chủ tiệm duyệt; không âm thầm xoá lịch.
- [ ] Owner + staff được hướng dẫn vận hành **sau** phép đo người dùng mới không hướng dẫn.

### I. Go-live
- [ ] **Go-live approval** — chữ ký/xác nhận của chủ tiệm: ________________
- [ ] **Kế hoạch rollback** theo đúng thay đổi thực tế đã thống nhất. Vercel rollback chỉ đổi
      code; không tự hoàn tác migration, dữ liệu đã ghi hoặc tin đã gửi. Có phương án riêng nếu
      pilot phát sinh những tác động đó.
- [ ] **Người hỗ trợ/theo dõi phản hồi** được chỉ định: ________________ (theo dõi Vercel runtime errors + booking thực tế; bất thường → rollback + điều tra).
- [ ] Cả hai salon được theo dõi 7–14 ngày; ghi đủ tỷ lệ tự hoàn thành năm việc (≥80%), tạo hẹn
      <60 giây, walk-in <30 giây, không quá một lần cần giúp ở ca đầu, không mất dữ liệu và
      **cả hai** muốn tiếp tục. Thiếu bằng chứng = **NOT PROVEN**, không tự tick PASS.

---

**Ký xác nhận hoàn tất onboarding:** ________________  ·  Ngày: __________
