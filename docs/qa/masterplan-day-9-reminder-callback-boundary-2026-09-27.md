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

## Bổ sung 27/09 — signed HTTP tới QA và giới hạn hosted

- Đăng nhập đúng project QA `uhpzafoiifupyypkcwln` bằng tài khoản quản trị đã
  được cho phép; không tạo tài khoản mới, không qua màn MFA Vercel. Một khóa
  `service_role` QA được gắn tạm vào riêng Preview branch, không áp Production.
  Recipient callback được chuyển sang `example.invalid`; secret ký là ngẫu
  nhiên và chỉ dùng cho Preview QA, không phải Resend provider credential.
- Preview đúng branch Ready, nhưng ba POST có chữ ký tới
  `/api/webhooks/resend` đều HTTP 403. Một POST rỗng độc lập cũng HTTP 403 với
  `x-vercel-mitigated: deny`; GET/HEAD chạm route và trả 405. Vercel runtime
  không có log request 403, QA không có receipt. Đây là chặn ở WAF trước route,
  không phải bằng chứng callback app hoặc DB thất bại. Kiểm tra read-only rule
  xác định `rule_card_receipt_release_fence_stale_deployment_writers_20260911_poPsrq`
  đang live: Preview host Ngày 9 không nằm trong allowlist và POST thuộc nhóm
  phương thức bị deny. Hai rule SDK booking/contact còn lại chỉ log-only.
  Không nới WAF vì rule này thuộc project NailIQ dùng chung với Production.
- Chạy cùng route qua `next start` local với `VERCEL_ENV=preview`, Supabase QA
  URL/anon/service-role khớp cùng project, QA-only webhook, mọi outbound và
  payment worker OFF. Lượt đầu thiếu anon key nên middleware trả 500; bổ sung
  đúng anon key QA và chạy lại. Signed synthetic `waitlist_offer` trả lần lượt
  `event_applied` HTTP 200, `event_replay` HTTP 200, và body khác cùng event ID
  trả `event_conflict` HTTP 409. SQL Editor trên QA xác nhận đúng 1 receipt
  `delivered` synthetic. Đây là **local HTTP → hosted QA DB PASS**, không phải
  hosted Preview E2E, provider delivery hoặc reminder dual-ledger E2E.
- Xóa đúng 1 receipt synthetic theo event ID/message ID/email key; hậu kiểm
  còn 0. Local server dừng, clipboard và biến khóa trong shell tạm đã xóa.
  Preview branch service-role được trả về placeholder vô hiệu; deployment mới
  `dpl_CMm2L6qeETRTRgM7sRMSagD5hexH` đã Ready. Ba deployment Preview cũ
  `dpl_BpyNQfUddNXwCEFpyVw3JfXkJeUL`,
  `dpl_8J7SGHtvsZry2Y9zeiCLFqPwMV34` và
  `dpl_9NLCD5N56NXcSH3cRphuN9DWVJym` vẫn Ready với môi trường build cũ;
  đổi branch env không thu hồi secret khỏi các deployment bất biến đó.
  Legacy QA key đã xuất hiện trong một tool-side accessibility capture. Cần
  lập kế hoạch thu hồi/rotate key và đánh giá các Preview cũ trước khi tái sử
  dụng QA rộng; chưa thực hiện vì có thể ảnh hưởng các consumer QA khác.
- Chưa có migration, Production mutation, booking, provider call hoặc SMS/email.
  PR #1435 vẫn Draft; không tính Ngày 9/P1-01 là đóng hoàn toàn.

## Phương án cô lập để hoàn tất hosted QA (kiểm tra read-only tiếp theo)

- PR #1435 vẫn Draft tại `6495c2aedb69bd2f219db77eae5d534ee25587c0`;
  các check GitHub hiện tại PASS/SKIP, không có FAIL. Preview an toàn mới Ready,
  nhưng thiếu service-role có chủ đích nên không thể ghi QA receipt.
- Project Vercel dùng chung `nailiq` có live deny rule cho non-allowlisted
  Preview POST. Không thêm host Ngày 9 vào allowlist, không dùng system bypass,
  không đổi hoặc publish WAF chỉ để xanh một bài test.
- Project riêng `nailiq-p1-01-waitlist-qa-20260914` không có custom WAF rule
  hoặc Preview env. Deployment 13 ngày trước chỉ được xác nhận Ready; metadata
  không cung cấp commit/source để chứng minh nó chạy toàn bộ app PR #1435.
  Repository có fixture UI synthetic `qa/waitlist-delivery`; không suy rằng
  deployment cũ chứa webhook hiện tại và không ghi đè project QA này.
- Đường ít ảnh hưởng salon Live nhất là một project Vercel QA mới, không có
  Production domain, chỉ deploy đúng commit PR #1435 ở target Preview. Cấu hình
  chính xác QA ref/URL/anon, secret server-only **mới và riêng cho QA runner**,
  chữ ký synthetic, recipient `example.invalid`, mọi outbound/provider/payment
  OFF. Kiểm tra từ signed HTTP qua hosted function tới đúng QA receipt,
  replay/conflict và dọn fixture. Không gọi Resend và không gửi thông báo.
  Đó vẫn chưa phải provider callback thật hoặc reminder scheduler proof.
- Không dùng lại legacy QA `service_role` JWT đã lộ trong tool output. Vercel
  `nailiq` có nhiều biến cùng tên ở các Preview branch khác; chỉ tên/phạm vi
  được kiểm tra, không có bằng chứng các giá trị giống nhau. Ba deployment cũ
  chứa khóa QA vẫn Ready. Thu hồi ngay legacy key có thể làm hỏng các consumer
  QA chưa kiểm kê; xóa deployment đơn lẻ cũng không thu hồi JWT. Theo
  [Supabase API-key guidance](https://supabase.com/docs/guides/getting-started/api-keys),
  tạo secret key mới song song, thay các consumer, xác nhận rồi mới deactivate
  legacy key. Việc này là một đợt bảo mật QA riêng, không phải thao tác tự động
  trong bài test Day 9.
- Chưa tạo project/key mới, chưa xóa deployment, chưa rotate/deactivate key,
  chưa đổi WAF, chưa commit/push tài liệu bổ sung. Cần phê duyệt phạm vi cụ thể
  trước các thao tác môi trường/bảo mật này.

## Bổ sung sau phê duyệt — project QA cô lập, chưa có hosted E2E

- Tạo project Vercel riêng `nailiq-day9-callback-qa-20260927` và checkout sạch
  đúng commit PR #1435 `6495c2aedb69bd2f219db77eae5d534ee25587c0` tại
  `/private/tmp/nailiq-day9-isolated-preview-20260927`; không mang theo thay đổi
  tài liệu đang làm dở. Project mới không có Git integration, domain NailIQ
  đang Live hoặc provider credential. Deployment protection của project là SSO
  cho deployment URL mặc định.
- Đặt biến chỉ trong môi trường Preview của project này: Supabase QA URL/ref,
  modern publishable key, QA-only signed-webhook boundary, recipient
  `example.invalid`, SMS/email/call OFF và các payment/provider worker OFF.
  Secret ký webhook synthetic được tạo ngẫu nhiên và lưu dạng sensitive;
  không phải Resend provider credential. Kiểm tra metadata thấy các tên biến
  Preview, không đọc/in giá trị khóa.
- Supabase connector hiện chỉ hỗ trợ đọc publishable key, không có thao tác tạo
  secret key. Browser automation đã timeout ba lần và dừng; không có
  `SUPABASE_ACCESS_TOKEN` khả dụng trong môi trường này. Vì vậy **chưa tạo
  modern secret key QA**, chưa đặt `SUPABASE_SERVICE_ROLE_KEY`, và không thể
  chạy signed hosted function → QA DB.
- Vercel CLI tự gắn lần triển khai đầu của project mới vào target `production`
  dù lệnh mặc định không có `--prod`; thử lại với `--target preview` cũng vẫn
  nhận `target=production` khi inspect. Cả hai lần đều bị ngắt trong lúc build
  và xóa chính xác deployment `dpl_H5MZMiGZyhF9FJYxAGHmsnoT4LwL` và
  `dpl_HRY3fGvj72W5FVXsynUXV3WA5sCy`. Hậu kiểm `vercel ls` sau cả hai lần
  xác nhận project QA không còn deployment. Không phải project `nailiq`
  Production và không có deployment Ready, nhưng đây là một sai lệch cần ghi
  nhận, không được gọi là Preview PASS. [Tài liệu Vercel về deployment đầu tiên](https://vercel.com/docs/domains/working-with-domains/deploying-and-redirecting)
  cũng ghi lần deploy đầu của project mới được đánh dấu Production; vì thế
  không lặp lại với cú pháp CLI khác dưới cùng ràng buộc Preview-only.
- Không thử lại cùng đường CLI hoặc dùng legacy QA JWT đã lộ. Hosted QA E2E
  vẫn **BLOCKED** cho đến khi có cách tạo key mới an toàn và Vercel xác nhận
  deployment được gắn target Preview trước khi chạy. Không thay đổi WAF,
  Production, dữ liệu salon, provider, booking hoặc thông báo. Tài liệu này
  vẫn chưa commit/push.

## Bổ sung sau khi chuyển sang project QA đã có deployment nền

- Theo phê duyệt tiếp theo, dùng lại project Vercel QA riêng
  `nailiq-p1-01-waitlist-qa-20260914`, đã có deployment nền từ 14/09. Kiểm tra
  project protection là SSO; Preview env ban đầu không có biến. Checkout sạch
  vẫn ở SHA PR #1435 `6495c2aedb69bd2f219db77eae5d534ee25587c0`.
- Cấu hình chỉ môi trường Preview: Supabase QA URL/ref, modern publishable key,
  recipient `example.invalid`, QA webhook-only và disposable DB, mọi công tắc
  SMS/email/call/payment/provider OFF; không thêm credential gửi hoặc key DB.
  Tạo secret chữ ký synthetic định dạng Svix, lưu sensitive. Secret synthetic
  đầu tiên sai định dạng đã được xóa khỏi cấu hình Preview rồi thay bằng secret
  mới hợp lệ; deployment cũ là bất biến và không được dùng làm bằng chứng test
  ký đúng.
- Lần build đầu trên project QA cũ lỗi vì framework preset `Services` nhưng
  source NailIQ không khai báo service. Dùng `--local-config` trỏ file tạm chỉ
  có `framework: nextjs` cho đúng deployment, không sửa setting project hoặc
  `vercel.json` trong repo, đồng thời không đưa cron vào cấu hình tạm. Build
  Next.js + TypeScript PASS. Deployment cuối
  `dpl_BKxjxqqroHDqDFEGhYH5ZuTYSzRG` được `vercel inspect` xác nhận
  `READY`, `target=preview`.
- Trên deployment cuối, một POST synthetic không chữ ký vào
  `/api/webhooks/resend` trả HTTP 401 `invalid_signature`. Một POST synthetic
  ký đúng nhưng không có QA marker trả HTTP 200 `event_ignored`; code route
  trả ở bước phân loại trước khi tạo DB client. Một POST synthetic ký đúng,
  có QA marker và đúng recipient trả HTTP 503 `webhook_store_unavailable`,
  đúng trạng thái fail-closed do chưa có server key. Truy vấn read-only
  Supabase QA xác nhận 0 receipt cho cả hai provider message ID fixture.
  Không gọi Resend, không gửi mail, không tạo booking hoặc ghi fixture.
- **Chưa có hosted function → QA DB PASS**: Supabase connector chỉ cho đọc
  publishable key, không tạo secret key; computer-use quản trị tiếp tục timeout.
  Không đặt `SUPABASE_SERVICE_ROLE_KEY` và không dùng legacy QA JWT đã lộ.
  Cần tạo modern QA-only `sb_secret_...` qua kênh quản trị an toàn, bind server-only
  vào đúng Preview QA, redeploy, rồi chạy signed apply/replay/conflict và dọn
  receipt. Chưa thay Production, WAF, salon Live hoặc PR state; tài liệu chưa
  commit/push.

## Hosted QA callback closeout sau khi kết nối quản trị khôi phục

Các dòng `BLOCKED` ở phần trên là ảnh chụp trạng thái trước khi khôi phục kết
nối; kết quả dưới đây thay thế kết luận hosted QA trước đó.

- Sau xác nhận của Huy tại thời điểm tạo khóa, tạo modern secret key có tên
  `nailiq_day9_preview_qa_20260927` trên duy nhất Supabase QA
  `uhpzafoiifupyypkcwln`. Không dùng legacy JWT đã lộ. Giá trị khóa không đưa
  vào code, report hoặc log; clipboard đã được xóa sau khi chuyển.
- Thêm `SUPABASE_SERVICE_ROLE_KEY` dạng encrypted/sensitive chỉ vào môi trường
  **Preview** của Vercel project QA cô lập `nailiq-p1-01-waitlist-qa-20260914`.
  `vercel env ls preview` xác nhận tên biến và scope; không đọc giá trị. Xoay
  riêng chữ ký webhook synthetic của Preview QA để runner có thể ký request;
  đây không phải Resend provider credential và không ảnh hưởng Production.
- Redeploy từ checkout sạch đúng SHA PR #1435
  `6495c2aedb69bd2f219db77eae5d534ee25587c0`, dùng local config chỉ
  `framework: nextjs` (không cron). `vercel inspect` xác nhận deployment
  `dpl_HZ25jppX58RK9SxRBjUV92jK4kQS` là `Ready`, `target=preview` trên
  project QA; không phải project `nailiq` Production.
- Trên chính deployment này, POST synthetic chữ ký sai trả
  `401 invalid_signature`. Ba POST ký thật theo Svix với recipient
  `example.invalid` và QA tag cho cùng event ID trả lần lượt
  `200 event_applied`, `200 event_replay`, `409 event_conflict`. Không gọi
  Resend hoặc provider; route chỉ nhận callback và ghi QA ledger.
- Truy vấn QA DB trước test có 0 receipt mang fixture ID; sau `event_applied`
  có đúng 1 row `registered_email_delivery_events` ở trạng thái `delivered`;
  replay không tạo bản thứ hai. Xóa chính xác row synthetic bằng cả event ID
  và message ID, rồi hậu kiểm count = 0. Không tạo booking, SMS/email thật,
  hoặc sửa dữ liệu salon Live.
- **PASS cho hosted signed callback → QA DB và idempotency/conflict của một
  registered-email fixture.** Chưa phải bằng chứng Resend provider delivery,
  cron thực tế, hay Production. Key QA mới vẫn tồn tại cho Preview cô lập;
  việc thu hồi/xoay thêm cần quyết định bảo mật riêng. PR #1435 vẫn Draft,
  chưa merge/Production tại thời điểm kiểm chứng.

## Bổ sung 27/09 — hosted reminder dual-ledger QA

- Theo phê duyệt riêng, xoay **chỉ** `RESEND_WEBHOOK_SECRET` synthetic trong
  Preview của project Vercel QA cô lập; không phải khóa Resend gửi thư. Biến
  sensitive không được update tại chỗ bằng CLI nên xóa rồi tạo lại ở đúng
  scope Preview. Khóa mới không in vào log/report và đã xóa khỏi shell tạm.
- `vercel redeploy` deployment nền thất bại do preset `Services` của project
  QA không khai báo service; deployment lỗi không được dùng làm bằng chứng.
  Build sạch bằng local config `framework: nextjs` hoàn tất, và `vercel inspect`
  xác nhận `dpl_4GnXHhzLuqGPtxkAdBfVKCjLKgjg` **Ready, target Preview**
  trên project QA riêng, từ checkout sạch SHA
  `6495c2aedb69bd2f219db77eae5d534ee25587c0`.
- Trên Supabase QA `uhpzafoiifupyypkcwln`, fixture synthetic riêng có đúng
  1 salon, 1 booking, 1 reminder claim trước callback; cả hai event ledger có
  0 row. Recipient là miền `example.invalid`; không gọi cron, provider hoặc
  worker gửi thông báo.
- Ba POST có chữ ký Svix synthetic qua hosted Preview trả lần lượt
  **200 `event_applied`**, **200 `event_replay`**, **409 `event_conflict`**.
  Hậu kiểm QA DB cho đúng 1 registered-email event `delivered`, 1 customer
  reminder event `delivered` đã apply, 1 reminder claim được cập nhật
  `email_delivery_status=delivered`, và 1 booking notification. Mỗi ledger
  chỉ có một row của event ID, nên replay không nhân đôi.
- Bản cleanup đầu bị trigger lifecycle nhân viên từ chối và transaction
  rollback; không vô hiệu hóa safeguard. Dùng đường xóa toàn bộ **salon giả
  đúng UUID/slug** với FK cascade được schema hỗ trợ. Hậu kiểm cả category,
  salon, service, staff, booking, claim, notification và hai event ledger của
  fixture đều **0 row**.
- **PASS cho hosted signed reminder callback → hai ledger QA và phép replay /
  conflict; fixture đã dọn sạch.** Đây không phải callback từ Resend thật,
  chứng minh cron 24h/3h chạy, gửi email/SMS tới inbox, hay Production.
  PR #1435 vẫn Draft, chưa merge hoặc deploy Production. CI của head PR phải
  được đọc riêng; không suy PASS CI từ bài QA hosted này.
