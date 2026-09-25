# Kiểm chứng thu phí hủy trễ / no-show — 2026-09-25

Trạng thái: sửa local/QA; chưa commit, push, phát hành Preview hoặc bật thu tiền Production trong task này.

## Nguồn và phạm vi

- Worktree riêng: `/Users/huytran/nailiq-fee-release-readiness-20260925`.
- Branch: `fix/fee-release-readiness-20260925`.
- Base: `006da9b322d3da154cb2f4bc36a491616957a631`.
- Production `/api/version` đọc trực tiếp ngày 2026-09-25 trả cùng SHA. Đây là phiên bản trước bản sửa này.
- Worktree gốc có thay đổi riêng, được giữ nguyên.
- Chỉ fixture synthetic, PostgreSQL/Supabase local disposable và Square Sandbox. Không thu tiền thật, không sửa booking khách thật, không gọi API gửi SMS/email/call. Thông báo tự phát tới tài khoản merchant Sandbox chưa được xác minh OFF; fixture không có phone/email khách.

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
- Full schema Supabase local: **139/139 assertions PASS**; đã áp đúng ba migration cuối trên clone mới chỉ có cấu trúc `nailiq_fee_final_acceptance_20260925`; no-show, late cancellation, group cancellation và legacy no-show PASS chuỗi approval → claim → unknown → reconciliation → webhook → replay; sai salon/số tiền/completion token bị chặn. Fixture rollback. Regression webhook tới sau hoàn một phần/toàn bộ PASS, no-show và cancellation; webhook cũ không ghi đè occurrence mới. Có khóa booking trước tính tổng refund. Chưa chạy riêng tình huống refund và webhook đồng thời; race đã chạy là cấp lease SQL và payment request Sandbox.
- Browser QA trên Preview của bản sửa này: **NOT RUN** — chưa được phát hành nhánh/Preview.
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
- Race refund/webhook đồng thời chưa chạy; có regression tuần tự và khóa booking trước aggregation. Deposit thiếu customer qua RPC mới chưa test SQL riêng; điều kiện mới chỉ áp dụng fee, deposit tiếp tục ngoài phạm vi Live V1.
- Provider/configuration lỗi sau khi cron đã cấp lease vẫn có thể tiêu hao attempt. Giới hạn thử vẫn an toàn về trùng thu, nhưng có thể cần xử lý thủ công sau exhaustion; chưa coi đây là phục hồi vô hạn tự động.
- Bản sửa gửi link lưu thẻ bằng email khi SMS tắt thuộc PR #1429, còn mở lúc kiểm tra; không mô tả là đã Live.
- Request deposit nằm ngoài phạm vi gateway V1 đã chốt; không được bật rộng cổng thanh toán chỉ để làm nút này hoạt động.
- Booking không có thẻ/consent hợp lệ không trở thành chargeable chỉ vì bật cấu hình. Không thể bảo đảm ngân hàng sẽ chấp nhận mọi khoản phí.

## Phân biệt trạng thái

| Mức bằng chứng | Trạng thái |
|---|---|
| Có trước task | Lưu thẻ, consent, Owner/Admin review, ledger, các gate mặc định tắt |
| Implemented locally | Bản sửa trên nhánh riêng, ba migration, fixture và harness |
| QA tested | Unit, local Supabase schema clone, Square Sandbox adapter; các bằng chứng được ghi riêng |
| Preview verified | Chưa — chưa xuất bản bản sửa này |
| Deployed | Chưa |
| Production verified | Chỉ xác minh SHA hiện tại; chưa xác minh thu phí live |

## Phát hành và rollback

1. Duyệt commit/push nhánh riêng và mở PR/QA Preview; chưa bật thu thật ở bước này.
2. CI, migration rehearsal và browser QA đạt; lưu rollback checkpoint schema/function và danh sách operation chưa rõ kết quả.
3. Duyệt riêng migration/Production release và allowlist salon/số tiền thử. Áp migration khi fee dispatch còn OFF; deploy code mới trước khi mở gate. Không chạy code cũ với operation reference mới.
4. Khi có lỗi: tắt gate tạo khoản thu mới toàn hệ thống và salon; giữ ledger/approval/receipt, không xóa operation, không cấp key mới. Chỉ tiếp tục đối soát đã được xác minh an toàn. Không rollback code mù khi còn operation mới chưa có kết quả. Giữ migration bổ sung đã áp; wrapper cũ chủ động từ chối fee event thiếu customer ID. Chỉ rollback app khi gate tương ứng OFF; không mở lại code cũ để nhận webhook phí thiếu ràng buộc.
5. Hoàn tiền là một thao tác riêng cần xác nhận và receipt; rollback phần mềm không tự hoàn tiền.

Kết luận: **PASS phần kiểm thử đã ghi nhận; CHƯA ĐẠT điều kiện mở Live cho toàn bộ salon** cho đến khi các mục Preview/rollout được hoàn tất.
