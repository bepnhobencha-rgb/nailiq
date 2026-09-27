# Master Plan — Ngày 9: reminder callback boundary

Ngày 27/09/2026 (Vancouver). Phạm vi P1-01, tiếp nối bằng chứng email Waitlist QA
và reminder recovery đã có. Nhánh local cô lập `qa/day9-delivery-truth-20260927`
được tạo từ `origin/main` tại `e719aa7c`; không gộp PR #1429 còn Draft.

## Đã kiểm chứng tại local

- Bổ sung hai ca dùng chữ ký Resend/Svix thật với dữ liệu synthetic, không mock
  bước xác minh chữ ký. Callback `booking_reminder` phải ghi cả receipt email
  đăng ký chung và receipt reminder theo cùng event/fingerprint, không chuyển
  email người nhận vào RPC.
- Tiêm lỗi ở lần ghi reminder sau khi receipt chung đã được chấp nhận: HTTP
  trả 503 để yêu cầu retry; khi receipt chung replay, lần retry vẫn đi tiếp
  tới receipt reminder với đúng material ban đầu.
- Callback có chữ ký hợp lệ nhưng tái dùng cùng event ID với body khác trả
  HTTP 409 tại ledger chung, không gọi tiếp ledger reminder. Test chữ ký
  vẫn dùng khóa synthetic; không gọi provider.
- Route callback và security-boundary tests liên quan: 47/47 PASS.
- Toàn bộ unit suite cuối: 7.187 PASS, 79 SKIP, 0 FAIL; 873 file PASS.
  Typecheck, ESLint các file đổi và Next webpack production build: PASS.
  Build có cảnh báo Edge Runtime sẵn có. Lượt full đầu tiên sau phần sửa
  opt-out có một structural test cũ FAIL vì kiểm tra chuỗi `return true`;
  cập nhật test để giữ cùng bất biến fail-closed ở API ba trạng thái, rồi
  chạy lại toàn bộ suite PASS. Không coi lượt FAIL đầu là PASS.
  Một lượt focused sau đó có 2 FAIL vì mock update thiếu bước `.in()` của
  marker nhóm; sửa harness và chạy lại 96/96 PASS, rồi full suite PASS.
  Lượt full đầu sau ca conflict: 4 Mailpit-localhost tests timeout vì sandbox
  từ chối `listen 127.0.0.1` (`EPERM`); 7.183 ca khác PASS. Chạy riêng 9/9
  Mailpit tests và chạy lại toàn bộ suite trong môi trường cho phép cổng
  localhost: 7.187 PASS, 79 SKIP. Không quy lỗi sandbox cho mã ứng dụng.

## Khe hở reminder nhóm được xử lý local

- Rà code thấy bước kiểm tra opt-out của thành viên nhóm trước khi tạo claim
  dùng boolean fail-closed: lỗi đọc database và opt-out thật đều trả `true`.
  Đường này có thể bỏ qua thành viên mà không tạo receipt rồi vẫn đặt marker
  hoàn tất của nhóm. Đây là phát hiện từ code path, chưa tái hiện Production.
- Bổ sung kết quả ba trạng thái `not_suppressed` / `suppressed` /
  `lookup_unavailable` cho reminder. Caller cũ `isEmailSuppressed` vẫn fail
  closed. Reminder cá nhân và trưởng nhóm không gọi provider khi lookup lỗi;
  trả lỗi pre-provider có thể retry thay vì ghi suppressed giả.
- Thành viên nhóm được tạo claim trước khi đánh giá opt-out trong hàm gửi.
  Opt-out thật tạo receipt `suppressed`; lookup lỗi tạo claim `failed` và
  giữ marker nhóm chưa hoàn tất để retry. Test runtime 24h/3h và sender
  mocked xác minh không gọi provider thật. 114/114 focused tests PASS trước
  khi thêm ca nhóm; lượt focused cuối cho sender + runtime: 96/96 PASS.

## Supabase QA rehearsal (không gửi email)

- Dùng dự án QA cô lập `nailiq-p0-03-qa-20260921` (`uhpzafoiifupyypkcwln`),
  xác minh các function signature trên database trước khi chạy. Không dùng
  Supabase Production `fshmobzyjhmtvndobwsy`.
- Chạy `rehearse-registered-email-delivery-truth.sql` và
  `rehearse-resend-customer-delivery-truth.sql` trong transaction có `ROLLBACK`.
  Bổ sung vào fixture thứ hai một event reminder ghi hai ledger theo thứ tự
  callback thật, rồi replay cùng event: cả hai trả `event_replay`, mỗi ledger
  giữ đúng một record. Bài rehearsal PASS trên QA.
- Query sau rollback xác nhận 0 salon synthetic và 0 reminder receipt ở cả
  hai ledger. Không sửa schema, không có dữ liệu fixture tồn lưu.
- Chạy thêm `rehearse-booking-reminder-delivery-claims.sql` trên cùng QA dưới
  `SET LOCAL ROLE service_role`, transaction có `ROLLBACK`: PASS với kết quả
  `booking_reminder_delivery_claim_rehearsal_pass`. Fixture nay assert rõ
  pre-provider failure có `provider_message_id IS NULL`, retry tái dùng đúng
  claim, attempt tăng từ 1 lên 2, và cuối cùng có đúng một receipt `sent`.
  Query hậu kiểm: 0 salon và 0 claim fixture. Thêm fixture này vào
  `migration-history-rehearsal.yml` để CI tiếp tục chặn hồi quy khi PR được tạo.
  YAML parse PASS; kết quả GitHub CI cần ghi riêng theo đúng head PR.
- Mở rộng `rehearse-resend-customer-delivery-truth.sql`: sau một replay đúng,
  cùng event ID nhưng payload fingerprint khác phải trả `event_conflict` ở
  cả hai ledger; fingerprint đã ghi không đổi. Chạy lại script trên QA trong
  transaction `ROLLBACK` không lỗi; hậu kiểm 0 salon fixture và 0 event fixture.
  Test route riêng cho ca này: 16/16 PASS.

## Chưa chứng minh

- Database trong hai ca HTTP mới là mock. SQL rehearsal trên QA kiểm tra RPC
  thật nhưng không nối signed HTTP → Supabase QA thành một luồng end-to-end;
  không phải provider callback thật, inbox hay SMS delivery.
- Preview branch `qa/day9-delivery-truth-20260927` được dựng qua commit fence
  không auto-deploy trước khi gắn 47 biến riêng cho branch. URL/ref Supabase
  trỏ QA disposable, ba kênh gửi và payment workers tắt, provider credentials
  ghi đè rỗng. `SUPABASE_SERVICE_ROLE_KEY` hiện là placeholder cố ý không hợp lệ:
  Preview có thể kiểm tra build và chữ ký bị từ chối, **không được tính là
  signed HTTP → QA database PASS**. Thao tác kéo toàn bộ Preview secrets về
  máy đã bị từ chối; không dùng đường khác để đọc/sao chép cả bộ credentials.
- Chưa kiểm chứng scheduler/reminder 24h/3h trên QA hosted. Không bật hoặc nới
  WAF, không tái sử dụng Resend credential Production/shared-account.
- PR #1429 thuộc Ngày 8 vẫn là Draft và có gate Preview riêng; test mới này
  không được tính là đóng Ngày 8 hoặc toàn P1-01.

Các rehearsal kể trên không áp migration, không thay Production, không tạo
booking thật hoặc gửi SMS/email/provider call. Trạng thái commit, PR và Preview
phải đối chiếu trực tiếp với GitHub/Vercel, không suy từ PASS local hoặc QA SQL.
