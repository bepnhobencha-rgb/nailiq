# QA Booking — Hi-Lite Head Spa (hilite-anaheim) — 2026-06-18

**Surface:** https://nailiq.ca/hilite-anaheim (desktop 1280px, EN)
**Giờ tiệm lúc test:** America/Los_Angeles (PDT)
**Build:** prod hiện hành (lịch mới + email-required CHƯA merge)
**Phạm vi:** luồng cá nhân (Individual), 7 bước, đi tới success thật bằng số 555 + tên "QA E2E Test".
**Dữ liệu test:** booking `#NQ-dc377135` (id `dc377135…`) đã **huỷ (cancelled)** sau khi test — không chiếm lịch, không nhắc lịch. SMS bị chặn (exchange 555). Email xác nhận gửi vào thehuytgvn@gmail.com.

---

## 🔴 BUG PROD: Khách nhận 2 email xác nhận + email sai tên tiệm (ĐÃ FIX)

Booking online có email → gửi **2 email "Booking confirmed"** (05:24:26 & 05:24:27, cách 1s), cả hai ghi tiêu đề **"hilite-anaheim"** (slug) thay vì "Hi-Lite Head Spa".

**Root cause (3 nguồn khớp):** `sendBookingConfirmationEmail` select cột `currency` (đúng là `currency_code`) → salon lookup lỗi → `salonRow=null` → (a) bỏ ghi log `booking_notifications` (chỉ có dòng SMS, không có email) → guard `count==0` của `/api/booking/sms-confirm` luôn pass, cộng `publicBookingSideEffects` gửi vô điều kiện = 2 email; (b) fallback tên=slug, tz=Vancouver, tiền=CAD.

**Fix (branch `fix/duplicate-confirmation-email`):** `currency`→`currency_code` + claim-before-send race-proof (`claimNotificationOnce` + partial unique index `booking_notifications_confirmation_once`). Migration đã áp prod. Ảnh hưởng MỌI khách online có email, không chỉ booking test.

## 🔴 Lỗi chặn / rủi ro chuyển đổi

**1. Thẻ no-show gây hiểu lầm là tùy chọn nhưng thực ra BẮT BUỘC.**
Phần "Secure your appointment" ghi *"Add a card to hold your spot… nothing now"* và có nút *"No thanks"* → khách tưởng có thể bỏ qua. Thực tế:
- Tick ô "I agree to the no-show policy" mà CHƯA nhập thẻ → Confirm báo đỏ *"Enter a valid card number"* + *"Could not save the card. Please check your details."*
- Bỏ tick ô no-show → nút **Confirm booking bị khoá** (xám), không đặt được.
→ Khách KHÔNG có thẻ bị kẹt cứng ở bước cuối mà không rõ vì sao (revenue path). **Bước tái hiện:** tới Review → tick đồng ý sức khỏe → thử Confirm.
→ Đề xuất: hoặc cho đặt không cần thẻ (nếu no-show không bắt buộc), hoặc nói rõ "Card required to confirm" + bỏ chữ "nothing now"/"No thanks" gây nhầm.

## 🟠 Trung bình

**2. Email vẫn "(optional)".** Bản "email bắt buộc" (`feat/email-required-online`) chưa merge lên prod → bước Your details vẫn hiển thị *Email (optional)*.

**3. SĐT không tự format khi gõ.** Nhập `7145550123` hiển thị nguyên `7145550123`, không thành `(714) 555-0123`. Giảm cảm giác "chỉn chu".

**4. Báo lỗi thẻ cũ còn dính lại.** Sau khi nhập thẻ hợp lệ (dòng đỏ "Enter a valid card number" biến mất), dòng *"Could not save the card. Please check your details."* của lần lỗi trước vẫn còn → dễ làm khách tưởng vẫn lỗi dù Confirm đã chạy.

## 🟢 Cơ hội cải thiện (UX)

**5. Upsell khó hiểu:** *"Your tech is free for 565 more minutes — want to add a service?"* — 565 phút ≈ 9 tiếng, con số lạ, không có ý nghĩa rõ với khách. Cân nhắc bỏ số phút hoặc đổi cách diễn đạt.

**6. Slot "1:25 PM" gắn nhãn "Recommended"** giữa lưới 15 phút (1:15/1:30) — giờ lẻ 25 phút trông lạ; xác nhận có chủ ý không.

---

## ✅ Đã kiểm tra OK (chạy tốt)

- **B1 Cổng vào:** phone-first; mặc định US/+1 đúng theo Anaheim; cụm US/CA/MX/Other; chấp nhận số 555; lời chào "Hi {tên} 👋".
- **Cá nhân/Nhóm:** cả hai nút hiện, Individual mặc định.
- **Stepper:** Phone → Services → Date → Time → Your details → Review, cập nhật đúng.
- **B2 Dịch vụ:** 5 gói, **giá USD đúng** ($85–$195), nhãn Popular/Featured, thẻ mở rộng.
- **B3 (thợ):** gộp trong luồng, "Any available staff".
- **B4 Ngày:** dải ngày bắt đầu **TODAY 18** (không rác quá khứ), chấm còn-chỗ, "More dates" mở lịch tháng.
- **B5 Giờ:** *"All times in PDT"* (đúng giờ tiệm), slot 15 phút, nhãn Popular/Recommended.
- **B6 Thông tin:** tên prefill, email có gợi ý "Recommended", ghi chú đặc biệt.
- **OTP (always_otp):** gửi **kép SMS + email**, masked `••• ••• 0123` / `t•••@gmail.com`, fallback email hoạt động, Resend đếm ngược.
- **B7 Review:** tóm tắt đúng (salon, dịch vụ, thợ, **giờ PDT**, 60 min, $85), mã ưu đãi, link Terms.
- **Success:** "You're all set! with Bella", ref **#NQ-dc377135**, QR, **Add to calendar / Share / Book another**, "Need to reschedule? Call (714) 537-1075".

## 🔎 Ghi chú QA-process (cho lần sau)

- Salon `always_otp` (như Hi-Lite) **không thể test-book bằng số/email giả**: OTP SMS bị chặn cho số 555, OTP email lưu **hash HMAC** (không đọc ngược được). Muốn test full submit cần **inbox thật** nhận mã, hoặc salon test tắt OTP.
- No-show card bắt buộc ⇒ cần **thẻ thật do người dùng tự nhập** (QA tool không nhập thẻ). Booking test xong nên **huỷ** ngay (đã làm) để không chiếm lịch.
