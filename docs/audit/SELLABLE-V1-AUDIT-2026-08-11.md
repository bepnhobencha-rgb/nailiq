# NailIQ Sellable V1 Audit — 2026-08-11

## Đối chiếu hiện hành — 2026-08-20

Phần còn lại của tài liệu này là snapshot lịch sử ngày 2026-08-11. Khi trạng
thái khác nhau, bảng dưới đây là kết luận hiện hành. Chưa thể tính trung thực
`x/313`: repository không có một inventory 313 mục với ID và trạng thái làm
nguồn chân lý; không được suy ra phần trăm từ số test hoặc số dòng trong bảng.

Đối chiếu trực tiếp artifact `NAILIQ_Master_QA_Checklist_10_10.docx` xác nhận
nguồn hiện có gồm **231 bullet duy nhất**, không có 313 item ID hay trạng thái
checkbox ẩn. Ledger chuẩn hóa 231 ID tại thời điểm cập nhật này: 22
PASS_PRODUCTION, 16 PASS_CI, 36 PASS_LOCAL, 22 FAIL, 97 NOT_PROVEN, 33
BETA_NOT_PROVEN và 5 NOT_APPLICABLE. PASS_LOCAL/CI không được cộng thành bằng
chứng production.

| Phạm vi | Trạng thái hiện hành | Bằng chứng / giới hạn |
|---|---:|---|
| Booking cá nhân: giá, promo, voucher, thuế, add-on, quote/reconfirm | ✅ PASS local | Giá do server tính; fingerprint, replay và transaction được rehearsal trên PostgreSQL sạch. Chưa có PR/CI/deploy/runtime production cho candidate hiện tại. |
| Any Staff: web, Phone Voice, lễ tân | ✅ PASS local | Stable request identity; retry sau response-loss trả cùng booking; lifecycle và capability fail-closed. Chưa có runtime production proof. |
| Web Voice booking | ✅ PASS local | Voice chỉ handoff vào Confirm chuẩn; không tạo booking trước OTP/consent/policy/quote và nút xác nhận. Chưa có browser E2E trên candidate đã deploy. |
| SMS/email xác nhận | ✅ PASS local | Durable claim trước provider; `sent`/`delivered` cần provider receipt; retry trạng thái mơ hồ trả 503 và không gửi lại. Không có provider-send thật trong vòng kiểm định này. |
| Email huỷ / đổi lịch cho khách | ✅ PASS local / ⚠️ runtime NOT PROVEN | Public, staff/desk và Voice dùng cùng outbox versioned, claim trước Resend, receipt bắt buộc và occurrence riêng cho A→B→A hoặc cancel→undo→cancel. Fresh-DB behavior/concurrency/rollback và app tests PASS; chưa deploy hoặc gửi provider-test thật. |
| Branding email salon | ✅ PASS local / ⚠️ inbox NOT PROVEN | Logo chỉ chấp nhận đúng configured Supabase Storage `salon-imports`; tên salon escaped luôn hiển thị khi ảnh bị chặn; EN/VI xuyên suốt confirmation/group/reminder/cancel/reschedule/staff-action. 8 files/62 tests + typecheck/lint/diff PASS; chưa có Resend inbox/image-proxy acceptance. |
| Link quản lý booking / waitlist / thẻ | ✅ PASS local / ⚠️ runtime NOT PROVEN | Capability tách riêng status/confirm/reschedule/cancel/card/group/waitlist; GET chỉ inspect, mutation dùng same-origin POST + stable request ID; raw booking ID bearer đã bị loại. App acceptance 11 files/99 tests và fresh-DB behavior/concurrency/rollback/ACL/parity PASS; chưa có browser/provider QA trên candidate deploy. |
| Quick Rebook API cũ | ✅ HIDDEN / fail-closed | Route orphan trả `410 Gone`; flow rebook chính vẫn đi qua OTP và submit chuẩn. |
| Guided Admin Setup | ⚠️ NOT PROVEN end-to-end | Source/security/local gates đã tăng cường, nhưng current combined SHA chưa có disposable authenticated browser E2E, CI, deploy hoặc production proof. |
| Group / party booking pricing | ✅ PASS local core / ⚠️ release NOT PROVEN | Public, desk và Phone Voice dùng server-authoritative quote/create nguyên tử cho member, add-on, promotion, voucher, email incentive và tax; fingerprint, exact replay, lost-response và concurrency đã PASS local. Legacy public RPC đã bị revoke trong candidate. Email receipt tổng hợp authoritative đã PASS local với durable claim/receipt truth, nhưng browser E2E, provider acceptance, CI/deploy và production runtime vẫn chưa được chứng minh; giữ BETA/OFF trước rollout. |
| Public AI text receptionist abuse boundary | ✅ PASS local / ⚠️ rollout NOT PROVEN | Beta/default-OFF với tenant + platform gate; same-origin JSON/body/prompt caps; operational tenant fence; durable SHA-256 IP/salon quotas fail-closed trước Anthropic; 63/63 focused tests. Không nêu giá/live slot khi thiếu authoritative proof, stream lỗi không bị xem là success. Chưa có PR/CI/deploy/runtime và quota chưa được hiệu chỉnh từ traffic production. |
| Global rate limiting / Vercel WAF | ❌ FAIL production | Read-only Vercel CLI ngày 2026-08-20 trả `active=null`, `rules=[]`, không draft và Attack Mode tắt. Candidate local đã bổ sung DB limiter fail-closed cho lookup khách, contact và card-provider endpoints, nhưng booking-page-load/auth WAF hooks vẫn là no-op khi không có rule. Không tạo/publish rule trong audit này. |
| Deposit / no-show payment | ❌ FAIL local contract / ⚠️ provider NOT PROVEN | Audit phát hiện deposit intent chưa gắn duy nhất với booking intent, no-show retry đổi provider idempotency sau outcome mơ hồ, refund dùng key ngẫu nhiên và partial refund chưa có durable contract. Đang bổ sung operation ledger/claim-complete-reconcile; không charge/refund thật trong kiểm định. |
| Reminder positive delivery | ⚠️ NOT PROVEN | Kill-switch/suppression có bằng chứng; delivery provider dương tính chưa được chạy trong candidate này. |
| Hi-Lite Head Spa / Hi-Lite Studio production smoke | ✅ PASS read-only current production / ⚠️ candidate NOT DEPLOYED | Ngày 2026-08-20, `/api/version` và `/api/health` trả SHA `9b4edbcf`; `/hilite-anaheim` và `/hilite-studio` trả HTTP 200. Không ghi dữ liệu/bật flag. Đây không phải browser/dashboard proof và không chứng minh local candidate. |

Candidate local tại thời điểm đối chiếu: branch
`audit/guided-p0-batch-20260819`, trước khi push/PR/deploy. Full local gates:
typecheck PASS; 330 test files PASS + 1 skipped, 1899 tests PASS + 1 skipped
and 7 explicit TODO acceptance cases;
lint 0 errors (49 warnings hiện hữu); i18n 0 errors (13 warnings hiện hữu);
production build PASS 60/60 static pages; migration history 360 unique, production
prefix 267/267 exact, không duplicate/name mismatch/production-only; PostgreSQL 17
fresh apply, ACL, atomic Group transaction, rollback, voucher-last-use, slot-race
và idempotency concurrency rehearsals PASS. Hợp đồng DB retry xác nhận thông báo
cũng đã PASS local trên PostgreSQL sạch, gồm behavior, concurrent claim/lease và
rollback, nhưng chưa có worker/scheduler hay provider adoption. Migration Group tự
fail trước mọi thay đổi nếu còn salon active bật `group_booking_enabled`;
production preflight chưa chạy. Không có provider, production customer data,
charge/refund hoặc outbound thật trong vòng này.

PR #1235 không phải bằng chứng cho candidate hiện tại: PR đang Draft/BEHIND và
head cũ; Guided E2E đỏ vì expectation cũ 50% trong khi readiness theo dữ liệu là
38%. Candidate local đã sửa expectation nhưng chưa được push và chưa có CI.

## Kết luận

**Chưa đạt Sellable V1 100%.** Luồng booking cốt lõi, vận hành lễ tân và
support/error monitoring đã có bằng chứng production trên Salon QA, nhưng đường
tiền Square/deposit và positive reminder delivery vẫn chưa được chứng minh
end-to-end.

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
| Resource / chair conflicts | ✅ | Salon QA production: explicit chair assignment và auto-assign đều ghi đúng `resource_id`; booking khác staff nhưng trùng chair/time bị chặn `slot_conflict`; outbound giữ tắt và dữ liệu test đã dọn | Salon không cần chair riêng có thể giữ feature tắt |
| Reschedule / cancel | ✅ | Luồng production đã được chạy; route/token và E2E tương ứng đạt | Không có blocker đã biết |
| Confirmations / reminders | ⚠️ | UI/config/cron và suppression guard tồn tại. Production cron sau commit `4190ff1` xác nhận cả `sms_outbound_enabled = false` và `email_outbound_enabled = false` đều không ghi marker/notification; commit `4966c46` đã thêm provider message ID cho email | Positive delivery tới địa chỉ provider-test vẫn cần phê duyệt cụ thể vì phải bật production email outbound |
| Deposit / no-show | ⚠️ | No-show thủ công production đạt; booking event được ghi; test QA không charge | Deposit/card-on-file/charge/skip/idempotency/refund chưa được chứng minh trên một provider kết nối |
| Client database / history | ✅ | Directory, search, profile/history và tenant isolation có production/E2E evidence | Không có blocker đã biết cho Pilot 1 |
| Square integration | ❌ | Code, schema và webhook tồn tại | Salon QA có `payment_provider = null`, không có `square_integrations`; chưa thể test tiền end-to-end |
| Mobile booking UX | ✅ | Mobile E2E và Visual Regression đạt ở commit production `8943d6e` | Tiếp tục smoke trên thiết bị pilot thật trước go-live |
| Owner / admin dashboard | ✅ | Dashboard, settings, services, staff và receptionist production đã dùng được | Không có blocker đã biết |
| AI receptionist | 🗑️ | Voice/AI code có nhưng QA không bật; setup route chưa được chứng minh cho tenant | Loại khỏi cam kết Pilot 1; chỉ Beta sau khi đạt reliability riêng |
| Support / error monitoring | ✅ | Production drill sau commit `4190ff1`: event `75b66879-0485-4d76-8363-93e059d4c988`, correlation `QA-SUPPORT-20260811-002`, được gắn đúng Salon QA; route tự resolve tenant phía server | Warning không gửi owner alert là hành vi đúng theo severity; không còn blocker V1 đã biết |

## P0 — blocker trước Pilot salon #1

1. **Chốt phạm vi payment cho Pilot 1.** Hoặc kết nối Square Sandbox và chứng
   minh save-card → consent → no-show charge/skip → idempotency → refund, hoặc
   tắt hoàn toàn deposit/card charge trong lời hứa Pilot 1 và dùng no-show thủ công.
2. **Chứng minh reminder delivery có kiểm soát.** Dùng số/email QA được phép,
   không dùng dữ liệu khách thật; kiểm tra send, receipt, retry, opt-out và audit.

## P1 — cần xong trước mở rộng 5 pilot

1. Thêm email xác nhận Group lấy duy nhất authoritative aggregate snapshot đã
   lưu, với durable claim/provider receipt; không tổng hợp tiền từ client.
2. Chạy Group browser E2E trên tenant QA sau migration preflight, gồm quote →
   confirm → exact replay và xác nhận không có booking/voucher/add-on thừa.
3. Smoke mobile trên iPhone/Android thật của owner và một khách pilot.
4. Kiểm tra reminder theo timezone Vancouver qua DST boundary.
5. Hoàn thiện runbook restore/offboarding staff và recovery booking.

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
2. **Đóng bằng chứng reminder có kiểm soát:** chỉ dùng địa chỉ provider-test,
   giữ SMS tắt và khôi phục email switch ngay sau kiểm tra.
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
- Reminder kill-switch production: scheduled cron run
  `6c04c923-e929-4e2b-a2c2-92a9e6f5d01b` hoàn tất 200 sau khi booking QA
  `33ee9a9a-393f-46cf-8567-f1a08a817083` được đưa vào cửa sổ 24h; cả hai marker
  vẫn NULL và không có notification row khi SMS/email outbound đều false.
- Support/error production drill: event
  `75b66879-0485-4d76-8363-93e059d4c988`, correlation
  `QA-SUPPORT-20260811-002`, tự gắn đúng salon
  `3f75cf3d-a8d8-4725-ac62-be3884e1711a`; event warning không kích hoạt email
  cảnh báo owner.
- Production hiện phục vụ commit `4966c46b8a743f1a08675373a0b8e87ede0e28a9`
  (PR #1231); CI và production deployment đều đạt. Email reminder thành công nay
  ghi Resend message ID vào notification audit row để đối chiếu provider.
- Resource/chair production test lúc `2026-08-12T00:58:50Z`: chair
  `27d66176-d118-4801-bc1a-4bdb14c07398`; explicit booking
  `b5f3968d-b112-4380-99cd-fb06093f2386` và auto-assigned booking
  `3b149908-eb9d-4666-94af-7786b850fafb` đều gắn đúng chair; lần đặt trùng
  cùng chair/time qua staff khác trả `{success:false, code:"slot_conflict"}`.
  Hai booking và chair tạm đã xóa; staff QA tạm được offboard inactive/deleted,
  0 active booking; salon trở lại `resources_enabled=false`, grid `staff`, SMS/email
  outbound vẫn false. Boundary tests resource/reminder đạt 8/8.
