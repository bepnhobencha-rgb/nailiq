# R11 — Candidate tích hợp, Square Sandbox và lỗi tự khóa salon

Ngày 13/09/2026. Đã chốt lượt Computer Use cuối và dọn môi trường QA. **Chưa deploy, chưa chứng nhận Production hoặc 100% Masterplan.**

## 1. Phạm vi và trạng thái nguồn

- Worktree nguồn W: `/Users/huytran/nailiq-p0-signup-acceptance-20260911`, branch `test/p0-signup-acceptance-20260911`, HEAD `ad99c9e012ff43b46b33571d3cbfd8c718a6c9d0`, 357 mục dirty lúc audit. Đối chiếu 4.040 hashes: chỉ file test Sandbox thuộc lượt R11 thay đổi, có backup. Không ghi đè phần việc khác.
- Candidate C: `/Users/huytran/nailiq-v1-release-candidate-20260913`, isolated detached worktree tại `0cb441a16387426decaf81b8601df288138d76bc`. Đây là **base**, chưa phải commit chứa các bản sửa local.
- Production metadata đọc lại lúc 15:46:48 UTC ngày 13/09/2026: READY, deployment `dpl_7v1pRVBmxp6A15MuHBdZdKZgH8pY`, SHA `0cb441a16387426decaf81b8601df288138d76bc`. Không query khách/booking Production, không thay đổi Production.
- C giữ nguyên 17 file chỉ có ở Production mới, gồm ba migration marketing đang Live. Overlay R10 không giao nhau với runtime/migration của Production delta. 13 test giao nhau chỉ khác số schema; đã ghép và giữ assertion hành vi/quyền. Một tài liệu rationale quyền bị bỏ sót khi lắp gói đã được bổ sung, không nới ACL/test.
- Inventory C: 531 migration files, trong đó 21 thuộc gói task so với base Git. **Không gọi 21 là số migration còn chờ trên database Production.** Hosted QA có 530 history rows nhưng thiếu các helper R07/R09/R10 khi đọc catalog; số history không chứng minh parity. Hosted QA không bị sửa trong lượt này.

## 2. Các lỗi xác định và sửa trong R11

### Salon có thể bị tự khóa từ deadline cũ

Cron cũ đọc danh sách grace hết hạn rồi pause theo salon ID. Nếu thanh toán/gia hạn đã commit giữa hai bước, helper vẫn khóa salon. Audit cũng được ghi trước khi mutation thành công.

RPC mới `pause_tenant_if_payment_grace_expired(uuid,timestamptz)` khóa row, kiểm tra lại `past_due`, trạng thái archive và deadline chính xác. Chỉ khi còn đủ điều kiện mới snapshot/tắt flags/ghi audit trong cùng transaction. Paid/extended/stale/duplicate đều skip; audit lỗi rollback; mất response sau commit có thể retry không lặp audit. Không đổi trial, giá, quyền manual pause/resume hoặc quy tắc thu phí.

Files: `src/app/api/cron/tenant-payment-pause/route.ts`, test cùng thư mục, `supabase/tests/tenant_payment_pause_fence.test.sql`, migration `20260913150803_fence_expired_tenant_payment_pause.sql`. Migration SHA256: `3eacdd1282479a6b5755e0c14a0453fe1adb16c88b0e6c59f49028e554928626`. Schema/ACL gates được cập nhật theo catalog đo thực tế, không đoán count.

### Link thẻ đã dùng xong bị báo nhầm là lỗi tải

Computer Use phát hiện `/booking/card` dùng capability đã tiêu thụ sau save trả `404/token_consumed`. UI cũ bỏ sót mã này và hiện “could not load”. Đây không phải thẻ bị mất hoặc provider503. Bản sửa đưa mã này vào thông báo link không còn dùng được, hướng dẫn xin link an toàn mới; không mở lại capability đã tiêu thụ. Luồng recovery cho booking đã saved đúng là không cho lưu lại thẻ bằng operation cũ.

### Có card ID nhưng thiếu bằng chứng vẫn bị báo đã bảo vệ

Đã tái hiện bằng SQL thật và Chrome: booking `manual_review` có card ID cũ nhưng thiếu consent/receipt vẫn hiện “securely saved” và số phí có thể thu. Nguyên nhân là RPC quản lý thẻ trả `has_card` theo việc có card ID; API và page dùng cờ vật lý đó để suy ra bảo vệ.

API `card-info` nay đọc projection phục hồi có bằng chứng bền vững, đối chiếu đúng booking/salon và card/customer/brand/last4. Chỉ `saved` nhất quán mới trả `protectionActive=true` và phí; dữ liệu mâu thuẫn chuyển `manual_review`. UI yêu cầu cả `protectionActive=true` và `protectionStatus=saved`; trạng thái thiếu chứng cứ hiện chưa kích hoạt và link phục hồi. Vẫn cho gỡ thẻ vật lý theo quyền cũ. Không thay RPC gỡ thẻ hoặc gọi lại provider. Số tiền hiển thị mô tả riêng phí no-show vì nguồn là `noshow_fee_cents`.

61 focused tests PASS. Năm kiểm tra SQL trên DB thật PASS, gồm legacy thiếu receipt, unknown/reconciliation_pending, manual_review, failed/retry_required; kiểm tra hủy trễ nằm trong cửa sổ có phí và đã consent nhưng thiếu durable receipt vẫn `has_chargeable_card=false`, `will_charge=false`. Không gọi RPC thu phí/no-show review để coi đó là bằng chứng mới.

### Trang quản lý thẻ lệch màu và có nguy cơ giữ trạng thái token cũ

API trả màu `#RRGGBB` đã lọc và theme light/dark sau kiểm tra quyền. Page dùng bộ biến theme booking có sẵn, giữ màu khi gỡ thẻ lỗi/thành công. Component được remount theo token để dữ liệu và phản hồi chậm của link trước không hiện dưới link mới. Đã kiểm tra Chrome dark/gold và light/blue; kiểm lại bản cuối ở phần bằng chứng UI.

### Lỗi công cụ QA được tách riêng

Guard SDK cũ không tương thích hợp đồng identity R10. Guard R11 ngoài source sản phẩm giữ name/reference cho authority theo booking, kiểm claim/lease/source fingerprint, giới hạn12 provider writes bền vững và chặn replay. Review độc lập còn phát hiện manifest có thể đổi scope giữa run và customer reference chấp nhận đoạn thừa; đã sửa, 72 mock tests PASS. Không sửa sản phẩm để bỏ qua các guard.

## 3. Square card-on-file: luồng và bằng chứng

Hợp đồng receipt/reconciliation là phần đã có trong các lô trước. R11 chạy lại trên **candidate ghép tại base Production hiện hành**, không nhận bằng chứng từ snapshot cũ làm bằng chứng bản này.

- Thành công: booking vẫn `confirmed`; card/customer binding, brand/last4, consent và operation `succeeded` đủ thì `saved`/“Card protection active”.
- Từ chối rõ ràng trên fixture mới chưa có thẻ: `failed`, `retry_required`, booking được giữ; không có card metadata/consent cuối và không được nói protected. UI hướng dẫn sửa/đổi thẻ, reload giữ trạng thái. Lượt mới chỉ bắt đầu sau khi lượt trước đã terminal; giữ lỗi gốc.
- Mất response CreateCard: operation `unknown`, không phát lại CreateCard/source; đợi lease và đọc đúng operation reference. Mất request trước DB completion: operation ban đầu còn `sending` với lỗi `database_completion_uncertain`, sau lease được đối soát. Mất response sau DB đã commit: giữ durable `succeeded`, đọc lại và hiện active; không hạ xuống unknown. Một receipt hợp lệ hoàn tất idempotently. Lỗi mạng/config không được giả thành not-found.
- Không có bằng chứng mới xác định chính xác bước lỗi của booking Production lịch sử `4378…` trong lượt này. Không kết luận khách không nhập thẻ. Sandbox hiện tại chứng minh các nhánh đã thử, không chứng minh lịch sử Production đã tự phục hồi.

## 4. Kiểm thử thực sự đã chạy

| Mức bằng chứng | Kết quả |
|---|---|
| Toàn bộ unit trên C đã chốt | 6.091 PASS /0 FAIL /65 skipped, 830 files; không tính skipped là PASS. |
| Build và typecheck | Next Webpack build rồi TypeScript tuần tự PASS sau tất cả sửa runtime, gồm câu phí no-show cuối. |
| Lint gói | 266 TS/JS files,0 errors/7 warnings; warnings nằm trong source đã có từ W; bốn file API/page và tests sửa cuối lint0 errors/0 warnings. Không coi warnings là lỗi runtime được chứng minh. |
| Schema/ACL thật | 246 tables,3.798 columns,225 policies,594 functions,162 triggers,1.012 indexes; parity/role/intentional-anon PASS. Cố tình GRANT anon/authenticated vào RPC pause trong transaction: gate bắt được cả hai; rollback và kiểm lại PASS. |
| Cron pause | 55 focused unit; SQL26 assertions +2 actual deny calls;4 DB race/timeout;4 route→SQL integration; rollback/second pass PASS. Các kết quả focused là tập con/liên quan, không cộng dồn thành số chức năng. |
| Square Sandbox backend | 8 PASS /0 FAIL /1 recovery-only skipped, API thật + PostgREST/DB local thật. Success,12 duplicate requests, decline/fresh retry, timeout trước dispatch, mất response CreateCard, DB-before/after, unverified identity tách customer và consumed-SMS authority chia sẻ đúng customer. |
| Kết quả DB backend | 10 booking;10 operation succeeded/3 failed;0 sending/unknown còn treo sau suite. Provider-response-loss và DB-before đều chỉ1 CreateCard,1 reference read sau lease thật. DB-after giữ durable succeeded,0 reference read. |
| Computer Use Chrome + SDK thật | Success→reload active; decline HTTP402→retry_required và reload đúng; nhập thẻ mới→HTTP200/saved, lỗi cũ còn trong history. Success1 customer/1 card; decline1 customer/2 CreateCard attempts (402,200); không tạo customer thứ hai khi retry. |
| Browser khác | Codex IAB tạo SDK form thất bại ở `payments.card()`, code được chuẩn hóa `square_sdk_error`, secure context=true; trước attach/provider write. Chrome cùng app/fixture hoạt động. Nguyên nhân SDK bên dưới còn UNKNOWN; không sửa selector dựa trên suy đoán. |

Square backend dùng fixed test nonce và thêm postal fixture tại guard: **không phải bằng chứng browser SDK**. Computer Use dùng ô thẻ của Square Sandbox, số thẻ thử công khai; không rewrite SDK token. Ảnh các trạng thái success/decline được chụp trực tiếp trong lượt Computer Use. UI này chạy local production build, **không gọi là Hosted Preview**.

## 5. Môi trường, quyền và dữ liệu

PostgreSQL/PostgREST local mới, loopback55631/55632, fresh local JWT; container network internal, cron/pg_net workers OFF. Không có hosted Auth/Storage/Realtime nên không nhận local stack là hệ Supabase đầy đủ. Source folded QA thiếu USAGE auth cho service_role: SQL pause test chỉ khôi phục bootstrap chính thức trong test transaction/clone rồi rollback/drop; không nới RPC migration hoặc suy ACL Production từ clone.

Square Sandbox seller/app/location CAD và tất cả webhook subscriptions được preflight read-only. Provider notification mode là `test_notifications_authorized` theo Huy đã cho phép; không tuyên bố provider notifications tuyệt đối OFF. NailIQ SMS/email/call, charge dispatch và Square sync OFF. Không thu tiền, không dùng thẻ/khách/booking thật. Journal chỉ giữ identifiers/outcomes/status an toàn; không lưu source token hoặc full provider payload. Capability/runtime/credential/dump được giữ ở evidence private ngoài repo.

### Bằng chứng UI cuối sau toàn bộ sửa

Chrome Computer Use trên production build local xác nhận: legacy có card ID nhưng thiếu consent/receipt hiển thị chưa kích hoạt, không hiện phí; thẻ đủ receipt hiển thị active/phí no-show trên cả light-blue và dark-gold; reload giữ đúng trạng thái. Link quản lý hết hạn trả hướng dẫn xin link mới. Link mới được cấp qua RPC chuẩn cho đúng booking synthetic, không mở lại token đã tiêu thụ/hết hạn và không gọi provider.

Ảnh Chrome trực tiếp nằm trong transcript Computer Use. Artifact `r11-cua/legacy-inactive-mobile.png` là export Chromium native UI tự động390×844, không overflow, không phải screenshot Computer Use. Không có claim rằng hai export light/dark mobile cuối đã chạy. `r11-cua/final-native-ui-result.json` ghi rõ từng evidence class và hash bốn file API/page/tests.

DB readback cuối: hai booking SDK đều confirmed/saved, đủ card/customer IDs, VISA1111, consent/metadata; fixture decline còn nguyên failed operation trước succeeded operation. Provider journal không đổi sau lượt SDK: success1customer/1card200; decline1customer/2card attempts402→200. Mọi kiểm tra đọc/link/theme cuối có0 provider writes.

### Cleanup hoàn tất

Đã dọn riêng fixture legacy hoàn toàn giả, xác nhận receipt hai fixture Square không đổi. Đóng hai tab QA do task tạo, giữ tab người dùng; dừng cổng3150/3151/3152. Archive DB local final ở quyền0600, checksum và TOC đã kiểm tra;12booking saved,16save operations terminal,11customer claims,0outcome pending,0network workers. Giữ archive/journal/receipts và các đối tượng Square Sandbox để truy vết; không gọi Square để xóa.

Đã xóa đúng hai container/network local R11 và dừng proxy/tunnel. Clone rehearsal `r11_candidate_20260913` rỗng được drop; tám database cũ nguyên vẹn. Container rehearsal được stop, không xóa; Colima trở về stopped, không có workload khác bị dừng. Evidence: `r11-local-stack/cleanup-complete.json`, `r11-rehearsal-cleanup-complete.json`, `r11-cua/ui-cleanup-complete.json`.

## 6. Rollback boundary

R11 chưa phát hành nên không có thao tác rollback Production. Có backup/hash các file trước sửa; có thể bỏ riêng delta R11 local mà không reset W hoặc xóa việc khác. Giữ audit Sandbox, không reset journal để thử lại operation unknown.

RPC pause là additive. Nếu lùi app về cron cũ, phải giữ cron pause dừng trong cửa sổ rollback hoặc fix-forward vì code cũ tái mở lỗi. Không tự unarchive/bật channels hay đổi billing state. Không đảo mù 21 migrations tích lũy: cần kiểm catalog/history Production thực tế, source guards, requests/asset cũ, backup/restore và cutover tương thích. R10 claimv2/R07 issuer có thể fail-closed nếu binary/schema không đồng bộ; app rollback không đồng nghĩa DB downgrade an toàn.

API card-info mới vẫn có thể trả503 thân thiện khi projection/dependency không sẵn sàng; đây là fail-closed để không suy bảo vệ từ card ID. Chưa có cơ sở cam kết mọi503 trong hệ thống đã hết.

## 7. Cổng còn mở trước ngày20

1. Hosted QA/Preview đúng candidate cuối và CI: chưa làm trong R11; cần duyệt gói cụ thể trước publish/apply hosted QA. Kiểm ba luồng cá nhân/nhóm/chuỗi và role/tenant trên exact candidate, không dùng Preview cũ.
2. REL-02: chốt quyền sau14 ngày, xác nhận thanh toán thủ công/paid-through/grace, chuyển đổi hai salon Live và bảng giá cuối. Lỗi cron đã đóng không thay quyết định thương mại. Câu hỏi access đã gửi; chưa có câu trả lời thì chưa triển khai policy phụ thuộc.
3. Chuẩn hóa inventory758/784 và đối chiếu từng ID/phạm vi V1/evidence. Chưa có cơ sở nói100% Masterplan. Google QA vẫn deferred; ưu đãi$2 đã chốt, không hỏi lại.
4. Pilot3salon/7–14 ngày theo Masterplan chưa được chứng minh. Nếu chưa đạt, ngày20 cần chốt pilot giới hạn sau đủ gate an toàn, không hứa phát hành rộng. Không mở rộng POS/TurnIQ/marketing để tăng số tính năng.

## 8. Phân loại nghiệm thu

**Existing before task:** R01–R10 card/OTP/CRM fixes ở W; newer Production marketing changes; stale grace bug, token-consumed copy bug và việc suy bảo vệ từ card ID vật lý.

**Implemented locally:** candidate ghép giữ Production, cron/RPC pause, mapping consumed-link, trạng thái bảo vệ có receipt trên trang quản lý thẻ, theme/token isolation, schema gates/test/rationale và QA harness.

**QA tested:** đúng các nhóm trong bảng; full gates cuối, Chrome native UI, receipt readback và cleanup đều hoàn tất; xem các evidence bên dưới.

**Preview verified / Deployed / Production verified:** **KHÔNG** cho candidate R11. Local/QA scoped PASS không cấp quyền publish. Release tổng **NO-GO / chưa100%** vì còn các cổng trên.

Evidence gốc: `/Users/huytran/nailiq-p0-signup-evidence-20260911/r11-*`, `r11-cua/`. Manifest cuối và checkpoint là chỉ dẫn tiếp tục; không dùng package-plan ban đầu298 files làm gói cuối.

Gói đề nghị duyệt bước tiếp theo: [CI và Preview riêng](r11-preview-publish-plan-2026-09-13.md). Đây là kế hoạch reviewable, chưa phải lệnh publish được thực thi.
