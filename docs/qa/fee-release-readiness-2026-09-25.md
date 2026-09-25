# Kiểm chứng thu phí hủy trễ / no-show — 2026-09-25

Trạng thái: đã commit/push, mở draft PR #1430 và tạo QA Preview; chưa merge, deploy Production hoặc bật thu tiền thật.

## Nguồn và phạm vi

- Worktree riêng: `/Users/huytran/nailiq-fee-release-readiness-20260925`.
- Branch: `fix/fee-release-readiness-20260925`.
- Base: `006da9b322d3da154cb2f4bc36a491616957a631`.
- Production `/api/version` đọc trực tiếp và kiểm tra lại ngày 2026-09-25 trả cùng SHA `006da9b322d3da154cb2f4bc36a491616957a631`. Đây là phiên bản trước bản sửa này; không có Production mutation trong đợt kiểm tra này.
- Worktree gốc có thay đổi riêng, được giữ nguyên.
- Chỉ fixture synthetic, PostgreSQL/Supabase local disposable, hosted Supabase QA riêng và Square Sandbox. Không thu tiền thật, không sửa booking khách thật, không gọi API gửi SMS/email/call. Thông báo tự phát tới tài khoản merchant Sandbox chưa được xác minh OFF; fixture không có phone/email khách.

## Các lỗi đã xác định và sửa

1. Mã tham chiếu `booking:<UUID>` dài 44 ký tự vượt giới hạn Square Payments 40 ký tự. Hai đường tạo operation mới lưu mã UUID 36 ký tự trong material bất biến và fingerprint. Operation cũ giữ nguyên payload để tránh thay đổi yêu cầu đã gửi. Webhook đối chiếu đúng reference đã lưu, salon, tài khoản provider, số tiền, tiền tệ và một operation duy nhất.
2. Lần thu đầu gửi note của loại phí nhưng cron gửi `Booking payment` với cùng idempotency key. Executor lấy note chuẩn từ loại phí và loại review đã lưu; lần đầu và lần phục hồi giống nhau.
3. Cron thiếu ngoại lệ cho phí hủy đã được Owner/Admin duyệt. Đã thêm purpose riêng và giữ hai lớp gate toàn hệ thống / salon.
4. SQL discovery bỏ sót Square fee khi `delivery_mode IS NULL` do logic ba giá trị SQL. Đã xử lý NULL đúng.
5. Discovery tiêu hao lượt thử cho salon hoặc loại phí đang bị tắt. RPC mới lọc gate trước khi cấp lease/tăng attempt; quyền gọi chỉ service_role.
6. Square từ chối thẻ qua `codes[]` nhưng executor chỉ đọc `code/decline_code`, nên bị gán unknown. Đã nhận diện allowlist lỗi 4xx rõ ràng; lỗi hỗn hợp, không biết, timeout, 429 và 5xx vẫn unknown.
7. Receipt thu thẻ chỉ kiểm tra id/status. Đã ràng buộc amount/currency/location/customer/reference, không báo đã thu nếu receipt thiếu hoặc sai.
8. Webhook phí hủy cập nhật ledger nhưng bỏ sót trạng thái đã thu trên booking. Đã bổ sung projection, tính refund từ ledger bất biến sau khi khóa booking; webhook tới sau hoàn phí không được xóa trạng thái refund hoặc ghi đè lần hủy mới hơn.
9. Webhook cũ không đối chiếu customer ID. RPC mới bắt buộc mã khách Square đúng với operation đã được duyệt; thiếu/sai mã bị chặn, kể cả replay. RPC cũ không thể bỏ qua ràng buộc này.

Nguồn contract: [Square CreatePayment](https://developer.squareup.com/reference/square/payments/create-payment).

## Kiểm thử đã chạy

- Unit/regression payment, no-show, Square, webhook, cron và security: **2.369/2.369 PASS**, không skip. Lần đầu broad run phát hiện danh mục dynamic SQL chưa có hai migration mới; đã review anchor tĩnh, cập nhật danh mục và chạy lại toàn bộ đạt.
- Typecheck: PASS.
- ESLint 17 file TypeScript sửa/thêm: PASS.
- Next production build: PASS. Lần chạy sandbox hệ điều hành bị treo; đã dừng đúng tiến trình QA và chạy lại tuần tự với quyền tạo tiến trình local. Không dùng môi trường Production.
- SQL fixture riêng: 11 kiểm tra gate/NULL/attempt/ACL PASS; hai worker đồng thời chỉ một worker có lease.
- Square Sandbox thật: lưu thẻ synthetic rồi thu phí thành công; replay cùng key cùng receipt; decline; mất phản hồi sau dispatch phục hồi bằng read-only; hai yêu cầu đồng thời cùng receipt. Chi tiết: [báo cáo Sandbox](square-saved-card-fee-sandbox-2026-09-25.md).
- Full schema Supabase local: **139/139 assertions PASS**; đã áp đúng ba migration cuối trên clone mới chỉ có cấu trúc `nailiq_fee_final_acceptance_20260925`; no-show, late cancellation, group cancellation và legacy no-show PASS chuỗi approval → claim → unknown → reconciliation → webhook → replay; sai salon/số tiền/completion token bị chặn. Fixture rollback. Regression webhook tới sau hoàn một phần/toàn bộ PASS, no-show và cancellation; webhook cũ không ghi đè occurrence mới. Có khóa booking trước tính tổng refund. Bổ sung 4/4 race thực tế refund/webhook: no-show và hủy trễ, một phần/toàn bộ; xác minh webhook chờ Lock trước khi refund commit và bảo toàn số tiền sau đó. Deposit thiếu customer PASS 4 assertions với RPC mới, wrapper cũ, ledger và replay.
- Browser QA Preview trên `65880b9d`: đăng nhập Owner synthetic PASS sau ngoại lệ firewall được Huy duyệt. Tạo/mở link quản lý thẻ và reload PASS, vẫn hiện Appointment reserved/chưa bảo vệ. Duyệt no-show $25 PASS với `approved_charge/dispatch_blocked`, miễn phí hủy trễ PASS với `waived/not_authorized`; đối chiếu DB không có payment operation. Card receipt fixture là mô phỏng UI, không phải bằng chứng Square đã lưu thẻ thật.
- Browser phát hiện hàng đợi phí hủy nhóm bị ẩn: loader truy vấn cột `group_size` không tồn tại trên bảng review; cột thật nằm trong `policy_snapshot`. Đã sửa loader và 16 regression tests. Computer Use trên Preview `4ac49e86` xác minh hàng đợi hiện đúng nhóm 2 khách; bấm Approve $25.00 thành công, hiện "No payment was sent; payment dispatch remains blocked". Reload giữ nút Collect; DB xác nhận cả no-show và group ở `approved_charge/dispatch_blocked`, tổng payment operations của bộ fixture vẫn bằng 0.
- Hộp xác nhận Collect từng mở để thử Cancel nhưng IAB không cung cấp dialog handle, còn native Codex bị công cụ cấm điều khiển. Kiểm tra lại hiện không còn dialog và browser hoạt động bình thường; Huy không cần bấm Hủy. Agent chưa xác nhận thu tiền, không mở lại Collect và không coi thao tác thu phí hoặc Cancel dialog đã PASS.
- Full unit suite sau cập nhật schema contract: **6.940 PASS, 0 FAIL, 79 SKIP** (7.019 total). Lần chạy trong sandbox hạn chế cổng localhost khiến 4 test Mailpit timeout; chạy lại với quyền loopback đạt.
- CI ở commit `4ac49e86`: Build & Type Check, Security Audit, migration rehearsal, smoke, tenant auth, SuperAdmin HTTPS recovery, receptionist Chromium/mobile, visual regression và chín component-browser jobs PASS. Non-RC và Settings recovery cũng PASS. Kết quả cuối của commit này: 23 checks SUCCESS, 2 SKIPPED theo workflow (MQA stage và AI triage), không có check FAIL hoặc đang chạy. Đây chưa phải bằng chứng CI cho bản preflight mới đang sửa local.
- Live fee collection: **NOT ENABLED / NOT TESTED** trong task này.

Bằng chứng local cuối: `/private/tmp/nailiq-fee-final-unit-20260925.json`, `/private/tmp/nailiq-fee-full-schema-final-20260925.log`, `/private/tmp/nailiq-fee-build-final-20260925.log`, `/private/tmp/nailiq-fee-final-typecheck-20260925.log`. Báo cáo Sandbox đã lưu bản sanitized trong repository.

## Các file chính

- `src/shared/integrations/square/client.ts`: xác minh receipt thu phí.
- `src/shared/payments/bookingPaymentOperations.ts`, `executeBookingPaymentOperation.ts`: material bất biến, request replay và phân loại decline.
- `src/app/api/cron/payment-reconciliation/route.ts`: routing và gate đối soát phí được duyệt.
- `supabase/migrations/20260925202830_gate_payment_reconciliation_discovery.sql`: discovery theo gate, quyền RPC và NULL semantics.
- `supabase/migrations/20260925203046_bind_fee_provider_request_reference.sql`: reference mới và projection webhook bảo toàn refund.
- `supabase/migrations/20260925204601_bind_square_fee_webhook_customer.sql`: RPC ràng buộc customer và wrapper legacy chặn thiếu bằng chứng.
- `src/shared/integrations/square/webhookRuntime.ts`, `src/app/api/webhooks/square/route.ts`: nhận và chuyển opaque customer ID; không trả ID ra response hoặc ghi vào inbox.
- `scripts/check-schema-parity.ts`: yêu cầu đủ cả hai RPC mới trước release. Danh mục dynamic SQL bảo mật đã cập nhật với các patch catalog có anchor cố định.
- Các test đi kèm; `scripts/qa/approved-fee-full-schema-local.sql`, `fee-reconciliation-discovery-local.sql`, `square-saved-card-fee-sandbox.ts`: fixture/harness synthetic.

## Luồng an toàn dự kiến

Khách lưu thẻ và đồng ý chính sách → có receipt lưu thẻ hợp lệ → phát sinh hủy trễ/no-show phù hợp chính sách → Owner/Admin duyệt đúng số tiền → xác nhận thao tác thu → Square xử lý → chỉ báo đã thu khi receipt đúng và DB hoàn tất.

Thẻ bị từ chối: không báo đã thu. Timeout/receipt không rõ: giữ unknown/pending, đối soát cùng operation và cùng key; không tạo một khoản thu mới. Sandbox cho thấy ListPayments có thể tạm báo APPROVED sau khi CreatePayment đã báo COMPLETED; phải giữ trạng thái chưa chắc chắn cho đến khi xác minh.

## Những việc còn phải kiểm chứng trước Live

- CI và browser QA Preview từ đúng bản sửa, với role Owner/Admin/Receptionist, không thẻ, thiếu consent, sai salon, double-click và reload.
- Kiểm tra cấu hình webhook signature, merchant/location/currency, quyền Square và các gate trên đúng deployment; không coi biến project là bằng chứng runtime đã bật.
- Kiểm tra operation chưa rõ kết quả trước khi mở gate; operation cũ không được đổi reference hay tạo key mới để thử lại.
- Race refund/webhook và deposit thiếu customer đã bổ sung PASS ở QA local; deposit vẫn ngoài phạm vi bật Live V1. Fixture race không xóa được qua cascade bình thường vì receipt bất biến; giữ trong clone disposable, không tắt guard.
- Bổ sung bản sửa local cho lỗi provider/configuration tiêu hao attempt trước khi gọi Square (chi tiết dưới). Operation đã hết ba attempt trước bản sửa không tự reset; phải đối chiếu riêng, giữ nguyên idempotency key và material.
- Bản sửa gửi link lưu thẻ bằng email khi SMS tắt thuộc PR #1429, còn mở lúc kiểm tra; không mô tả là đã Live.
- Request deposit nằm ngoài phạm vi gateway V1 đã chốt; không được bật rộng cổng thanh toán chỉ để làm nút này hoạt động.
- Booking không có thẻ/consent hợp lệ không trở thành chargeable chỉ vì bật cấu hình. Không thể bảo đảm ngân hàng sẽ chấp nhận mọi khoản phí.

## Phân biệt trạng thái

| Mức bằng chứng | Trạng thái |
|---|---|
| Có trước task | Lưu thẻ, consent, Owner/Admin review, ledger, các gate mặc định tắt |
| Implemented locally | Bản sửa trên nhánh riêng, ba migration, fixture và harness |
| QA tested | Unit, local Supabase schema clone, Square Sandbox adapter; các bằng chứng được ghi riêng |
| Preview verified | Một phần: Owner login, retry link/reload, duyệt no-show, miễn phí hủy trễ, hàng đợi nhóm/duyệt/reload PASS; collect chưa được thực hiện |
| Deployed | QA Preview; không Production |
| Production verified | Chỉ xác minh SHA hiện tại; chưa xác minh thu phí live |

## Phát hành và rollback

1. Đã duyệt và thực hiện commit/push, mở [PR #1430](https://github.com/bepnhobencha-rgb/nailiq/pull/1430), tạo [QA Preview](https://nailiq-fee-qa-20260925.vercel.app). Chưa bật thu thật.
2. CI, migration rehearsal và browser QA đạt; lưu rollback checkpoint schema/function và danh sách operation chưa rõ kết quả.
3. Duyệt riêng migration/Production release và allowlist salon/số tiền thử. Áp migration khi fee dispatch còn OFF; deploy code mới trước khi mở gate. Không chạy code cũ với operation reference mới.
4. Khi có lỗi: tắt gate tạo khoản thu mới toàn hệ thống và salon; giữ ledger/approval/receipt, không xóa operation, không cấp key mới. Chỉ tiếp tục đối soát đã được xác minh an toàn. Không rollback code mù khi còn operation mới chưa có kết quả. Giữ migration bổ sung đã áp; wrapper cũ chủ động từ chối fee event thiếu customer ID. Chỉ rollback app khi gate tương ứng OFF; không mở lại code cũ để nhận webhook phí thiếu ràng buộc.
5. Hoàn tiền là một thao tác riêng cần xác nhận và receipt; rollback phần mềm không tự hoàn tiền.

Kết luận: **PASS phần kiểm thử đã ghi nhận; CHƯA ĐẠT điều kiện mở Live cho toàn bộ salon** cho đến khi các mục Preview/rollout được hoàn tất.

## Cấu hình QA và chặn Preview đã xác minh

- Chỉ nhánh `fix/fee-release-readiness-20260925`: Supabase QA `osdqutwunokiielbairj`; service-role key và JWT riêng lưu dưới dạng biến sensitive của Vercel. Không dùng credentials Production.
- Đã áp ba migration của PR lên Supabase QA. Hai RPC mới và wrapper legacy chỉ service_role gọi được; anon/authenticated không có EXECUTE.
- SMS/email/call OFF; hai fee dispatch gate, payment worker, Square webhook ingestion, card/continuation reconciliation OFF. URL công khai trỏ về alias QA riêng.
- Checkpoint CUA: alias trỏ deployment `dpl_K9SQumY6UzKDRVjjRe4EGGAWV9y8`, commit metadata `4ac49e86554297acd253b6a29d0165210bd80078`, Vercel READY. Chưa đọc được runtime /api/version vì Vercel protection; không dùng metadata làm bằng chứng runtime endpoint.
- Sau Huy duyệt: rule live version 17 đã áp đúng ngoại lệ hostname QA+preview+POST và ba đường dẫn đã nêu. Action vẫn deny; cron, rule khác, CRS, IP rules và firewallEnabled giữ nguyên. Bản draft cũ đã sao lưu và phục hồi có rebase ngoại lệ QA mới, vẫn chưa publish; pendingChanges=1.
- Đã chuẩn bị đề xuất local chỉ cho host QA này, environment preview, POST và ba đường dẫn: `/login`, `/dashboard/card-truth-preview-20260911/no-show-protection`, `/dashboard/card-truth-preview-20260911/center`. Ma trận 5.313 trường hợp và review độc lập 13.600 trường hợp PASS, chỉ ba trường hợp QA được đổi quyết định; mọi case Production và cron payment-reconciliation giữ nguyên. Active sau publish đã đối chiếu đúng payload được duyệt.
- Đề xuất local: `/private/tmp/nailiq-fee-firewall-proposal-20260925.json`. Trước bất kỳ publish nào phải đọc lại active version/draft, giữ draft của công việc khác, kiểm tra scope và có phê duyệt riêng. Rollback ngoại lệ phải tái dựng trên active mới nhất để không xóa thay đổi của người khác.

## Bản sửa hàng đợi nhóm từ Computer Use

- Existing before task: loader lấy `group_size` trực tiếp từ review table, PostgreSQL trả 42703 nhưng bị đổi thành danh sách rỗng. Đây là lỗi code có trước task, không phải migration QA thiếu.
- Implemented locally: dùng `policy_snapshot.group_size`; fallback `bookings.group_size` hợp lệ cho snapshot cũ. Lỗi DB trả thông báo an toàn thay vì giả vờ không có review. Giữ lọc salon và quyền Owner/Admin. Không thêm migration.
- Focused: 26/26 tests, typecheck và touched ESLint PASS; full unit 6.940 PASS, 79 skip.
- Hosted QA fixture: 6 booking synthetic thuộc đúng salon Synthetic Card Preview QA, 3 review; missing-card/no-consent bị RPC từ chối trước khi tạo review. Tất cả provider IDs có prefix qa-simulated; outbound và dispatch OFF. Dữ liệu có receipt bất biến được giữ làm QA evidence; không bypass cleanup guard.
- Preview `4ac49e86`: hàng đợi nhóm hiện đúng 2 khách; duyệt phí và reload PASS, DB `approved_charge/dispatch_blocked`, tổng payment operations của fixture bằng 0. Chuyển ngôn ngữ tiếng Việt hiển thị đúng các nhãn duyệt/thu và phân biệt duyệt với chuyển tiền. Thu phí Live chưa được kiểm chứng.

## Nghiệm thu bổ sung trước khi mở thu thật

| Hạng mục | Bằng chứng hiện có | Gate còn thiếu |
| --- | --- | --- |
| Phí no-show | Owner approve + DB dispatch_blocked, Square Sandbox adapter và SQL lifecycle PASS | Browser Collect end-to-end với Sandbox, không dùng fixture receipt mô phỏng |
| Phí hủy trễ | Waive + immutable receipt, SQL lifecycle/race PASS | Browser approve/collect bằng Sandbox |
| Phí hủy nhóm | Queue 2 khách, approve/reload/DB PASS trên 4ac49e86 | Browser collect bằng Sandbox |
| Không thẻ / thiếu consent | Hosted QA từ chối tạo fee review | Không được chuyển thành chargeable khi bật gate |
| Phân quyền | Unit Owner/Admin vs Receptionist/nail_tech và CI tenant isolation PASS | Phiên UI fee riêng cho Admin/Receptionist chưa kiểm chứng |
| Khôi phục mất phản hồi | Square Sandbox cùng key/cùng receipt, SQL lease/race PASS | Lỗi đọc cấu hình trước provider đang được bổ sung fix trước Live |
| Chỉ báo đã thu khi có receipt | Validated provider binding, ledger/webhook/refund tests PASS | Đối chiếu Square/ledger trên salon Live chỉ sau phê duyệt riêng |
| Rollback | Gate toàn hệ thống + allowlist salon; giữ ledger và key bất biến | Chụp checkpoint mới trước lần phát hành thực tế |

Bản sửa preflight cấu hình đã đạt kiểm thử local/hosted QA; tiếp theo chạy CI và xác minh Preview mới. Không tự bật các gate tiền thật để hoàn thành nghiệm thu.

## Sửa lỗi cấu hình tiêu hao lượt đối soát

- Nguyên nhân: RPC discovery cấp lease và tăng `attempt_count` trước khi executor đọc cấu hình provider. Lỗi cấu hình liên tiếp có thể đưa operation tới giới hạn ba lượt dù lần đó chưa gọi Square.
- Local: đọc candidate chỉ thuộc loại phí được bật, salon allowlist boolean true, đến hạn và không có lease còn hiệu lực; resolve cấu hình và kiểm tra Square binding trước mọi lease. Provider được giữ trong bộ nhớ cho chính operation đã kiểm tra; toàn bộ material/fingerprint/salon/kind phải khớp claim trước khi dispatch.
- Migration bổ sung `20260925220858_preflight_fee_reconciliation_before_claim.sql`: RPC chỉ nhận tối đa 100 ID sẵn sàng và loại phí hợp lệ, kiểm tra lại gate salon/due state dưới `FOR UPDATE SKIP LOCKED`, chỉ service_role gọi được. NULL/empty readiness không claim. Giữ nguyên RPC cũ, ledger, key và material. Schema contract tăng 602 → 603 functions.
- Giữ tổng giới hạn 25 claim cho generic + fee workers; không tăng tải provider khi tách discovery. Quét tối đa 50 candidate mỗi loại; nếu chạm giới hạn báo `scanLimitReached` và unresolved, không giả vờ toàn bộ hàng đợi đã được xử lý.
- Focused: **120/120 PASS**. Full unit cuối: **6.966 PASS, 0 FAIL, 79 SKIP** (7.045 total); typecheck, touched ESLint và Next build tuần tự PASS. Lần broad đầu chỉ thất bại vì danh mục biểu thức PostgREST chưa có truy vấn mới; đã review và thêm AST guard chỉ cho phép bốn biến thời gian ISO do server tạo trong template, chạy lại toàn bộ đạt.
- Hai truy vấn PostgREST cuối trên hosted QA trả HTTP 200, không lỗi, 0 dòng khi gate OFF. Chỉ GET, không provider call hoặc mutation; xác minh cú pháp/join/filter, không thay thế bằng chứng claim dương trong SQL fixture.
- Full schema clone: **154/154 assertions PASS**, gồm ba loại phí qua RPC mới và operation legacy qua RPC cũ, toàn bộ fixture rollback. Lần đầu vướng email synthetic trùng fixture race cũ; đổi email riêng, chạy lại đạt. Reduced schema **16 assertions PASS**, 20 lần readiness rỗng giữ nguyên dữ liệu; hai worker chồng nhau chỉ một claim/tăng một attempt. RPC cũ giữ nguyên.
- Migration mới đã áp riêng lên hosted QA: anon/authenticated không EXECUTE, service_role có EXECUTE, readiness rỗng trả 0 claim và bộ fixture vẫn 0 payment operations. Không sửa Production hoặc mở gate. CI xanh trên `4ac49e86` không được dùng làm CI proof cho patch mới.
- Bằng chứng: `/private/tmp/nailiq-fee-preflight-full-unit-final-20260925.json`, `/private/tmp/nailiq-fee-preflight-full-schema-20260925.log`, `/private/tmp/nailiq-fee-preflight-build-20260925.log`, `/private/tmp/nailiq-fee-preflight-postgrest-20260925.json`; harness race tái lập trong `scripts/qa/fee-reconciliation-preflight-local.py`.
