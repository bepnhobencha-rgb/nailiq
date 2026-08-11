# NailIQ Sellable V1 Audit — 2026-08-11

## Kết luận

**Chưa đạt Sellable V1 100%.** Luồng booking cốt lõi và vận hành lễ tân đã có
bằng chứng production trên tenant `nailiq-qa-2026-07-26`, nhưng đường tiền
Square/deposit và delivery reminder thật chưa được chứng minh end-to-end.

Quy ước:

- ✅ hoàn thiện: có bằng chứng production hoặc E2E tương ứng và không còn gap V1 đã biết.
- ⚠️ có nhưng cần test/fix: đã có code/UI nhưng thiếu một phần bằng chứng vận hành.
- ❌ chưa có: chưa thể dùng đúng yêu cầu V1.
- 🗑️ hoãn: chủ động loại khỏi Pilot 1 để không làm chậm ngày bán.

## Bảng Sellable V1

| Nhóm | Trạng thái | Bằng chứng hiện tại | Gap còn lại |
|---|---:|---|---|
| Onboarding salon | ✅ | Production đã chạy từ đăng ký email mới → xác nhận → tạo salon → hours/address → public page ready; hệ thống tự seed 10 dịch vụ và 1 staff | Không có blocker onboarding đã biết |
| Services / price / duration | ✅ | Production QA đã create, edit giá/thời lượng và soft-delete; DB sạch sau test | Không có blocker đã biết |
| Staff / skills | ✅ | Production QA đã create, edit role/skills; offboarding an toàn đạt; PR #1225/#1226 và E2E desktop/mobile đạt | Không dùng hard-delete trong Pilot 1; giữ lịch sử bằng inactive |
| Working hours / break / day off | ✅ | Production QA: break 12:00–13:00 chặn public + receptionist; day-off 2026-08-13 không có slot; DB không ghi booking | Không có blocker đã biết |
| Online booking | ✅ | Booking production QA đã hoàn tất; conflict/race có smoke và E2E | Không có blocker đã biết |
| Any Staff / Specific Staff | ✅ | Cả hai lựa chọn đã chạy qua booking QA | Không có blocker đã biết |
| Group / party booking | ✅ | Production group booking 2–3 người đã thành công; race/duplicate đã được sửa | Không gửi reminder thật trong QA |
| Resource / chair conflicts | ⚠️ | Resource/bed picker và conflict E2E tồn tại | Feature đang tắt trên Salon QA; chưa có bằng chứng production theo tenant |
| Reschedule / cancel | ✅ | Luồng production đã được chạy; route/token và E2E tương ứng đạt | Không có blocker đã biết |
| Confirmations / reminders | ⚠️ | UI/config/cron và suppression guard tồn tại; production retest sau commit `691c0e5a` xác nhận `sms_outbound_enabled = false` không gọi/log SMS | Chưa có delivery receipt end-to-end bằng kênh sandbox/được phép |
| Deposit / no-show | ⚠️ | No-show thủ công production đạt; booking event được ghi; test QA không charge | Deposit/card-on-file/charge/skip/idempotency/refund chưa được chứng minh trên một provider kết nối |
| Client database / history | ✅ | Directory, search, profile/history và tenant isolation có production/E2E evidence | Không có blocker đã biết cho Pilot 1 |
| Square integration | ❌ | Code, schema và webhook tồn tại | Salon QA có `payment_provider = null`, không có `square_integrations`; chưa thể test tiền end-to-end |
| Mobile booking UX | ✅ | Mobile E2E và Visual Regression đạt ở commit production `8943d6e` | Tiếp tục smoke trên thiết bị pilot thật trước go-live |
| Owner / admin dashboard | ✅ | Dashboard, settings, services, staff và receptionist production đã dùng được | Không có blocker đã biết |
| AI receptionist | 🗑️ | Voice/AI code có nhưng QA không bật; setup route chưa được chứng minh cho tenant | Loại khỏi cam kết Pilot 1; chỉ Beta sau khi đạt reliability riêng |
| Support / error monitoring | ⚠️ | Health routes, Sentry hooks, error cron và audit log tồn tại | Cần diễn tập một lỗi booking có correlation/audit và quy trình owner escalation |

## P0 — blocker trước Pilot salon #1

1. **Chốt phạm vi payment cho Pilot 1.** Hoặc kết nối Square Sandbox và chứng
   minh save-card → consent → no-show charge/skip → idempotency → refund, hoặc
   tắt hoàn toàn deposit/card charge trong lời hứa Pilot 1 và dùng no-show thủ công.
2. **Chứng minh reminder delivery có kiểm soát.** Dùng số/email QA được phép,
   không dùng dữ liệu khách thật; kiểm tra send, receipt, retry, opt-out và audit.
3. **Diễn tập support/error.** Một lỗi có chủ đích phải xuất hiện trong monitoring,
   có mã tra cứu, tenant đúng và hướng xử lý cho owner.

## P1 — cần xong trước mở rộng 5 pilot

1. Bật và test resource/chair cho đúng một salon thực sự cần resource riêng.
2. Smoke mobile trên iPhone/Android thật của owner và một khách pilot.
3. Kiểm tra reminder theo timezone Vancouver qua DST boundary.
4. Hoàn thiện runbook restore/offboarding staff và recovery booking.

## P2 — sau Pilot 1

1. AI receptionist Beta với test corpus, fallback người thật và ngưỡng reliability.
2. Resource nâng cao cho salon không cần trong đợt đầu.
3. Báo cáo nâng cao, loyalty, marketing automation và các tính năng growth.

## Test cases bắt buộc trước khi gọi Sellable V1

1. Salon trắng → services → staff/skills → hours → public page ready.
2. Any Staff và Specific Staff không double-book khi hai khách submit đồng thời.
3. Break, closed date và day-off đều trả về không có slot và không ghi booking.
4. Group 2 và 3 người: success, duplicate submit idempotent, cancel whole party.
5. Reschedule sang slot hợp lệ; reject slot vừa bị chiếm; cancel link dùng một lần.
6. Reminder 24h/3h: đúng timezone, opt-in, suppression, retry và delivery receipt.
7. No-show không có thẻ: mark/undo/audit, không charge.
8. Nếu Pilot 1 bật payment: consent, save card, charge/skip, double-click no-op,
   provider error, retry và refund về đúng salon.
9. Client search/history không lộ tenant khác.
10. Mobile 390px: booking, reschedule, cancel và owner desk không có action ngoài viewport.
11. Lỗi booking có correlation ID, monitoring event và hướng fallback cho owner.

## Kế hoạch ngắn nhất

1. **Quyết định thương mại:** Pilot 1 không thu deposit cho đến khi Square Sandbox
   đạt toàn bộ payment test; no-show thủ công đã sẵn sàng.
2. **Đóng bốn bằng chứng không cần tiền:** onboarding trắng, break/day-off,
   reminder sandbox và support drill.
3. **Chạy một full journey cuối:** khách mobile đặt → owner thấy lịch → reminder
   sandbox → reschedule → no-show/cancel → client history/audit.
4. Chỉ sau khi mọi P0 đạt mới đổi kết luận thành **Sellable V1** và mời Salon #1.

## Evidence snapshot

- Production merge: `8943d6e551254f80d89ff0ff6af096b2ee3fa39b` (PR #1226).
- CI trên PR #1226: Build & Type Check, Security Audit, Smoke, non-RC E2E,
  Receptionist Center chromium/mobile và Visual Regression đều pass.
- Staff QA: `[QA-AUDIT] Temp Tech 20260811` → `inactive`, 0 active bookings,
  outbound SMS/email đều false.
- No-show QA booking: `f755b507-c62f-48c5-ba1a-a5785e62f6ae` → `no_show`,
  `deposit_status = not_required`, không có charge, có `booking_status_changed` event.
- Salon QA payment: `payment_provider = null`, không có Square integration.
- Fresh onboarding QA: salon `nailiq-onboarding-qa-2026-08-11`
  (`3f75cf3d-a8d8-4725-ac62-be3884e1711a`) đã đạt “Trang đặt lịch đã sẵn sàng”; booking
  `c230d86f-a35e-4837-bb60-921299cfc8fa` xác nhận thành công cho Staff 1 lúc
  2026-08-12 09:00 PDT, không deposit.
- Safety evidence: SMS/email outbound đều false, payment provider null; số QA 555
  được ghi `SUPPRESSED_fictional_test_number_*`, không gửi tới khách thật. Bằng chứng
  này đồng thời phát hiện confirmation route đã bỏ qua salon SMS switch.
- SMS kill-switch production retest sau merge `691c0e5a`: booking
  `33ee9a9a-393f-46cf-8567-f1a08a817083` được xác nhận, nhưng
  `sms_confirmation_sent_at` và `sms_confirmation_failed_at` đều NULL, đồng thời
  không có `booking_notifications` channel SMS. Không có outbound SMS attempt.
- Break/day-off production QA: Staff 1 có break thứ Tư 12:00–13:00 và day-off
  2026-08-13. Public booking và receptionist đều không cho chọn slot; database
  xác nhận 0 booking trong break, 0 booking ngày nghỉ và 0 booking từ hai lần thử
  `QA Desk Break` / `QA Desk Day Off`.
