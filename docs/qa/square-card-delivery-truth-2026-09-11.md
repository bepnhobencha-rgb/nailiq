# P0 Square Card-on-File Delivery Truth — QA và chuẩn bị Preview

Ngày kiểm tra: 2026-09-11 UTC. **Local/QA và Square Sandbox: PASS trong phạm vi mục 12. Phát hành: FAIL / NOT READY** vì chưa có Preview được duyệt và chưa chốt hosted schema/parity. Mục 11 giữ checkpoint trước khi được phép chạy provider; mục 12 thay thế trạng thái backend/SDK còn thiếu ở checkpoint đó. Báo cáo này không phải phê duyệt triển khai.

## 1. Nguyên nhân gốc và giới hạn bằng chứng

Booking `4378c3c6-f485-4ab4-9cb2-2011e82f5d66` của Hi-Lite Head Spa đã được tạo. Operation `987f7f2a-31b8-4d4c-8abd-71389f3797f1` có consent và dispatch preparation nhưng không có receipt lưu thẻ thành công. Không có cơ sở kết luận khách chưa nhập thẻ.

Hai lỗi hệ thống được chứng minh từ code và schema thực tế:

- Nhiều lỗi provider bị gom thành `unknown / provider_exception`; reconciliation sau đó ghi đè thành `provider_reconciliation_ambiguous`. Schema cũ không lưu stage, HTTP status hay lịch sử nguyên nhân. Fingerprint operation khớp payload completion ban đầu `unknown / provider_exception` không có receipt.
- Xác nhận booking và kiểm tra card ID chưa phân biệt đầy đủ “đã giữ lịch” với “đã có thẻ bảo vệ”. Một số luồng bỏ management token sau lỗi; token đã tiêu thụ không tải lại recovery state; hết lượt reconciliation không có đường nhập lại an toàn.

**Chưa xác định được lỗi provider cụ thể của incident:** bằng chứng còn lại không phân biệt SearchCustomer, CreateCustomer, CreateCard hay parse JSON. Bản sửa bổ sung khả năng phân biệt cho lần chạy mới; không tái tạo được thông tin đã mất. Không gọi Square Production để điều tra thêm.

Vòng kiểm tra tiếp phát hiện hai lỗi độc lập, không được coi là nguyên nhân đã chứng minh của incident Production:

- Hai booking độc lập của cùng khách có thể cùng CreateCustomer bằng hai key khác nhau. Đã tái hiện với transport giả; bản sửa dùng claim danh tính theo salon/merchant/environment/contact, khóa ngắn và body/key/reference bền vững. QA xác minh một lần tạo khách, kể cả response loss và retry sau đối soát.
- Hai operation trong cùng một giao dịch có thể trùng `created_at`; sắp theo UUID ngẫu nhiên có thể chọn lỗi cũ thay cho receipt thành công mới. SQL rehearsal đã bắt được lỗi này. Bản sửa thêm `delivery_sequence` làm thứ tự phụ; giữ nguyên timestamp và thứ tự `created_at,id` của lịch sử cũ, không suy diễn lại thời điểm thực của lịch sử.

## 2. Lỗi xảy ra tại bước nào

Mã gốc resolve config **trước** preparation. Incident có preparation `2026-09-11T02:05:31.302204Z`, completion lỗi `02:05:32.301231Z`.

| Bước | Kết luận incident |
| --- | --- |
| Commit booking | Đã thành công |
| Resolve Square config | Đã vượt qua để đến preparation |
| Ghi consent và preparation | Đã thành công |
| Search/CreateCustomer/CreateCard/parse response | Lỗi thuộc khối này; chưa đủ thông tin chọn một bước |
| Provider receipt hợp lệ | Chưa có bằng chứng đã nhận được |
| DB completion `unknown` | Đã ghi bền vững |
| DB timeout sau provider success | Được thêm kiểm thử; chưa phải nguyên nhân đã chứng minh của incident |
| Reconciliation | Ba lượt, ambiguous/manual; không chứng minh thẻ chưa từng được tạo |

Khoảng một giây này không chứng minh timeout 5 giây phía browser. Mã gốc `return completeSave(...)` không có `await`; Promise rejection từ DB completion không đi vào catch provider đó.

## 3. Vì sao chỉ có `provider_exception`

Catch quanh provider save/receipt thay lỗi cụ thể bằng mã chung. Square adapter có thể ném lỗi ở search, create customer, create card hoặc đọc response. Reconciliation lại thay mã ban đầu, không có bảng lịch sử giữ nguyên nhân.

Bản mới lưu stage, operation/booking/salon/provider, HTTP status nếu đã nhận, mã Square allowlist, retryability, timestamp và outcome. Events append-only giữ nguyên nhân đầu tiên. Không đưa raw body, source token, Authorization, access token, số thẻ, CVV, expiration hoặc contact đầy đủ vào diagnostics. Contact nghiệp vụ có sẵn trong `provider_material` và bản chụp request đầu tiên trong claim customer chỉ dùng cho nghiệp vụ/idempotency, ở bảng service-only; không đưa vào events, log hay Owner exception list.

## 4. Revision, files và migration

- Checkout gốc `/Users/huytran/nailiq`: branch `fix/embed-closure-banner`, SHA `0d9651082ba15916f2e31f804399b1ee3b573e5c`; giữ nguyên ba tài liệu TurnIQ chưa tracked.
- Isolated worktree `/Users/huytran/nailiq-square-card-delivery-truth-20260911`.
- Branch sửa `fix/square-card-delivery-truth-20260911`; base/HEAD `15fe1091fd71eda4a67704d08e5ab535967e5904`; chưa commit.
- Production `/api/version` và origin/main cùng SHA trên **tại audit đầu task**. Đây không phải bằng chứng deploy hotfix.
- Migration mới: `supabase/migrations/20260911040747_square_card_delivery_truth.sql`.
- Hosted continuation function khớp `20260827224306`, chưa khớp `20260911023439`. Cần kiểm tra parity trước release; không tự apply mọi migration đang chờ.

| Nhóm | Thay đổi |
| --- | --- |
| Square/payment adapter | Stage errors, safe HTTP status, strict receipt, claim customer dùng chung giữa booking, exact phone/email/reference lookup, card pagination |
| Save/reconciliation | Binding trước CreateCard; tách provider/DB errors; không replay source; lease và lịch sử |
| PostgreSQL | 7-state projection, RPC service-only, customer claims/leases, delivery sequence, events, recovery/consent, fee guards, revocation, receipt removal/disabled |
| Customer UI | Giữ link sau save, reload state, retry/hết hạn, fresh consent cho receipt cũ |
| Staff UI | Exceptions cho Owner/Admin; tên viết tắt, reason/time, open booking/link/reconcile/review; receptionist badge |
| Eligibility | Receipt đầy đủ mới đủ điều kiện phí; required/card ID riêng lẻ không đủ |

Danh sách file đầy đủ ở phụ lục. Audit trước sửa: `/Users/huytran/nailiq-square-card-delivery-truth-evidence-20260911/AUDIT_BEFORE_EDIT.md`.

## 5. Luồng mới

Booking commit trước provider call. Chỉ **Card protection active** khi DB chứng minh card/customer ID, brand/last4, consent timestamp, policy metadata/version và durable successful operation receipt đều khớp booking. `noshow_card_required=true` chỉ là yêu cầu.

| State | Hành vi |
| --- | --- |
| `not_required` | Không yêu cầu thẻ |
| `awaiting_card` | Lịch đã giữ, chờ nhập thẻ |
| `saving` | Chờ lần đang chạy, không dispatch lần hai |
| `saved` | Receipt/consent đầy đủ, protection active |
| `reconciliation_pending` | Chỉ đọc theo `nq-card:<operation_id>`, không replay source |
| `retry_required` | Lần trước kết thúc rõ ràng; capability hợp lệ rồi tokenize thẻ mới |
| `manual_review` | Không protected; đối soát lại có giới hạn, không tự chọn giữa nhiều matches |

Thông báo: “Lịch hẹn đã được giữ, nhưng thẻ chưa được lưu. Vui lòng thử lại để kích hoạt bảo vệ hủy trễ/no-show.”

- Config/search lỗi trước mutation: giữ stage, cho retry an toàn. Search lỗi mạng không có nghĩa customer không tồn tại.
- Customer identity: dùng chung claim theo tenant/merchant/environment/contact chuẩn hóa; không gộp khách chỉ theo tên. Lần tạo khách unknown chỉ đọc reference. Sau ba lượt đọc rỗng đúng policy, retry giữ nguyên body/key đầu tiên. Legacy success không khóa khách thường xuyên; legacy unknown được nhận key/reference cũ. Email fallback chỉ nhận một match exact có phone trống hoặc khớp, chặn phone mâu thuẫn.
- Decline rõ ràng: không gắn thẻ, yêu cầu thẻ mới; replay không tạo operation/provider mutation mới.
- Mất response hoặc DB completion uncertain: không gọi CreateCard lần hai; một receipt hợp lệ tìm bằng reference được complete atomically.
- Zero matches: ít nhất ba lần đọc đầy đủ thành công **và** 15 phút quan sát trước `retry_required`. Config/network failure không tăng lượt đọc hoàn thành, không thành not-found. Đây là policy local cần xác minh tiếp; không phải cam kết SLA của Square.
- Multiple/malformed/binding mismatch: manual. Một card disabled hợp lệ với binding operation v2 được kết thúc để nhập mới, không gắn card disabled vào booking. Square xác nhận disabled ngăn cập nhật/thu phí tiếp. [Square DisableCard](https://developer.squareup.com/reference/square/cards-api/disable-card)
- Token đã tiêu thụ chỉ đọc đúng booking tới expiry, không dispatch lại. Thu hồi vì lý do khác vẫn có hiệu lực sau reconciliation. Owner link mặc định 25 phút; không tự gửi cho khách.
- Legacy receipt thiếu policy version: cần khách đồng ý policy hiện hành và candidate vừa được đọc hợp lệ. Read mới ambiguous/failed vô hiệu candidate cũ.
- Gỡ thẻ có receipt khớp lần lưu: cho nhập thay thế. Mất metadata không có receipt gỡ vẫn chặn.
- Fee guard ở cả app và DB; không bật charge dispatch.

**Đề xuất grace period:** cấu hình theo salon `card_protection_grace_minutes`, mặc định 30 phút từ lúc giữ lịch, chỉ dùng hiển thị hạn hoàn tất và exception. Chưa triển khai policy này; không auto-cancel hay tự gửi nhắc.

## 6. Kiểm thử thực sự đã chạy

Supabase disposable trên loopback, dữ liệu/account synthetic. Các lượt integration cũ dùng Square mô phỏng và khóa trống; lượt mới ở mục 12 dùng Square Sandbox thật, có quyền cho phép provider email/SMS. SMS/email/call của ứng dụng và charge dispatch vẫn OFF. Các lớp bằng chứng được giữ riêng.

| Gate | Kết quả cuối | Evidence file |
| --- | --- | --- |
| Baseline trước sửa | 20/20 PASS | `baseline-focused.json` |
| Unit/regression vùng liên quan | **996/996 PASS, 126 files** | `sandbox-regression.json` |
| PostgreSQL + helpers thật, Square mô phỏng | 19/19 PASS | `integration-acceptance.json` |
| Migration từ QA DB sạch | PASS | `db-reset-acceptance.log` |
| SQL rehearsal | 16/16 scenario PASS; rollback transaction | `sql-rehearsal-acceptance.log` |
| Save race | 20 concurrent → 1 CreateCard, 1 CreateCustomer | Integration |
| Cross-booking customer race | 2 booking → 1 CreateCustomer; follower retry dùng lại customer | Integration |
| Customer empty-read recovery | 3 reads/15 minutes; key/body không đổi; stale lease/ACL bị chặn | Integration |
| Sandbox guard | **44/44 PASS**, gồm kiểm tra chế độ cho phép thông báo | `sandbox-final-guard.json` |
| Reconciliation race | 12 concurrent → 1 provider read | Integration |
| Typecheck | PASS sau build cuối | `sandbox-final-typecheck.log` |
| Lint 54 TS/TSX | 0 errors, 1 warning có trước ở BookingGroupFlow | `lint-acceptance.log` |
| Next build | PASS với webpack, build rồi typecheck tuần tự | `sandbox-final-webpack-build-fixed.log` |
| Browser localhost tự động trước Computer Use | 23/23 PASS; 0 runtime errors/outbound browser requests trong lượt đó | `ui-qa.json` |
| Computer Use + SDK Sandbox thật | 11/11 kiểm tra phạm vi; backend chặn trước network, xem mục 11 | `cua-ui-results.json` |
| Lint 8 file của lượt Computer Use | 0 errors, 0 warnings | `cua-form-lint.log` |
| Migration với lịch sử lớn | PASS dữ liệu/rollback; 10.000 booking, 60.000 operation synthetic; thời gian chờ đọc/ghi khoảng 4,4 giây | `migration-load-rehearsal.json` |
| Square Sandbox backend CreateCard thật | **7/7 PASS**, thêm một ca phục hồi read-only PASS; Computer Use save/decline/retry/reconciliation thật xem mục 12 | `sandbox-backend-run3.json`, `sandbox-backend-recovery1.json`, `cua-sandbox-ui-results.json` |
| Preview | NOT VERIFIED; Huy đã duyệt publish nhánh QA, đang chuẩn bị | Xem mục 14 |

996 test cases không tương đương 996 chức năng, không phải kết quả kiểm kê 784 chức năng.

| Acceptance | Bằng chứng hiện có |
| --- | --- |
| 1. Save/consent/succeeded/active | Integration/SQL + Square Sandbox thật, Computer Use, receipt DB đầy đủ |
| 2. Decline, không duplicate | Unit/integration + Square Sandbox HTTP 400, fresh retry qua UI |
| 3. Timeout trước dispatch | Config/search integration, zero mutation |
| 4. Response loss không CreateCard lại | Integration + Sandbox thật, injection mất phản hồi, UI/ledger chứng minh một CreateCard |
| 5. Một match atomically/idempotently | Integration/SQL/race + GET Square Sandbox thật, UI/DB khôi phục |
| 6. Zero matches theo policy | Integration/SQL + ba GET Square Sandbox thật, thời gian chờ thật, UI mở form mới |
| 7. Multiple → manual | Integration/SQL |
| 8. Invalid receipt không protected | Unit/integration/SQL |
| 9. DB loss trước/sau commit | Integration + Sandbox thật với fault injection; DB-before có Computer Use |
| 10. Reload/link/retry | Browser/SQL |
| 11. Chưa saved không chargeable | SQL/late-cancellation unit; không charge thật |
| 12. Tenant isolation | Owner action unit, SQL privileges, browser salon B bị từ chối |
| 13. Không log PII/secrets mới | App canary/unit/integration PASS; **có ngoại lệ lộ token Sandbox trong công cụ**, mục 12 |
| 14. Square Sandbox thật | **PASS trong phạm vi 7 backend cases và Computer Use ở mục 12** |

Review độc lập phát hiện/sửa ba lỗi: hồi sinh link bị thu hồi, gỡ thẻ xong bị kẹt, disabled receipt bị kẹt. Second pass chấp nhận; SQL 9/15/16 và integration cuối qua. Browser harness trước đó có lỗi đợi dashboard/loading và nút Mark reviewed vốn disabled; đã sửa assertion, chạy lại 23/23. Lỗi UI thật “mất nút retry khi config lỗi” và “thiếu token hiển thị sai” đã sửa source trước build cuối.

Kiểm tra bổ sung Vercel Preview trước đó: nhánh `qa/master-checklist-preview-20260822` còn bốn tên biến Sandbox (application, merchant, location, access token), nhưng API đọc từng biến xác nhận cả bốn giá trị đều rỗng. Không tải toàn bộ environment, không thay đổi Vercel và chưa gọi Square. Evidence: `sandbox-vercel-config-audit.json`. Bộ cấu hình Vercel này vẫn không sử dụng được; phiên Square Developer hiện đã đăng nhập được như ghi dưới đây.

Vòng continuation: thêm 19 kiểm thử guard Sandbox, customer concurrency và legacy identity coverage; tất cả dùng dữ liệu synthetic. Dựng app có một lần dừng vì kiểu dữ liệu `it.each` trong test mới; đã sửa để từng case truyền đúng toàn bộ mảng và chạy lại các gate. Hướng dẫn chạy Sandbox thật: [Sandbox certification](square-card-sandbox-certification.md). Lịch sử Sandbox PASS tháng 8 được tìm thấy chỉ là evidence cũ, không tính cho hotfix này.

Continuation kiểm tra Square bằng Chrome thật: ứng dụng **NailIQ Hi-Lite Anaheim QA**, tài khoản **NailIQ Canada QA**, location `L5VVHHWJMTEZB`. Sandbox application ID đã đọc từ UI là `sandbox-sq0idb-S23JctKhfeikhPHDGCtQzg`; chưa xác minh identity bằng API. OAuth authorization của tài khoản Canada đang hiện hạn 21/09/2026, không cấp mới/gia hạn/thay quyền. Màn hình Webhooks có Sandbox được chọn và không có subscription. Mục Notifications của merchant chỉ trỏ tới `dashboard#`, không mở cài đặt.

Bộ test cũ dùng một khóa cho cả seller và webhook, nên không phù hợp tài khoản Canada dùng OAuth: [Square yêu cầu personal token cho Webhook Subscriptions API](https://developer.squareup.com/docs/webhooks/webhook-subscriptions-api). Đã sửa riêng harness để dùng khóa ứng dụng hiện có cho đọc webhook, xác minh cùng Sandbox app; giữ seller token cho customer/card, giữ kiểm tra merchant/location/CAD và chặn mutation khi preflight lỗi. Không thay code ứng dụng hoặc migration trong vòng này. **26/26 unit guard PASS**, lint hai file PASS, Next build rồi typecheck PASS; review độc lập scoped PASS. Chưa gọi API bằng khóa thực.

**Chặn còn lại:** không đồng nhất zero webhooks với toàn bộ provider notifications OFF. [Tài liệu Sandbox](https://developer.squareup.com/docs/devtools/sandbox/overview) giới hạn câu không hỗ trợ gửi email ở phần Dashboard; [Square staff xác nhận invoice Sandbox có gửi email](https://developer.squareup.com/forums/t/does-the-sandbox-environment-send-an-email-notification-to-the-user/6616). Chưa tìm được bảo đảm hiện hành riêng cho `CreateCustomer`/`CreateCard` về email/SMS khách và merchant. Đã rà soát độc lập cùng kết luận. Vì vậy chưa copy token, chưa tạo customer/card và chưa chạy 7 case provider. Cần cài đặt OFF kiểm chứng được hoặc xác nhận Square đúng hai endpoint này; bản câu hỏi kỹ thuật đã chuẩn bị tại `square-support-notification-question.md` trong evidence, chưa gửi.

Bổ sung rehearsal migration trên Supabase PostgreSQL 17.6 dùng một lần, từ 502 migration nền trước hotfix, với hai salon synthetic, 10.000 booking và 60.000 operation. Chạy nguyên migration trong một transaction bằng `psql --single-transaction`; không chạy ứng dụng, provider hay scheduler, không dùng dữ liệu Production.

- Migration hoàn tất trong **4,511 giây** trên máy QA này. Probe đọc operation mất **4,394 giây**, probe UPDATE rồi ROLLBACK mất **4,371 giây**; đây là thời gian đầu cuối của probe, không phải SLA hoặc số đo Production. Đã quan sát `AccessExclusiveLock` trên bảng operation, booking và capability.
- Toàn bộ cột có trước trên 10.000 booking và 60.000 operation bằng snapshot trước migration, gồm ngày giờ, trạng thái, consent, provider material và receipt. Hash/count của **37 bảng liên quan** notification/payment/continuation/catalog giữ nguyên, nhưng **34 bảng rỗng**, gồm payment/continuation; không chứng minh bảo toàn giao dịch đang hoạt động trong các bảng này.
- Oracle fixture độc lập khớp cả bảy trạng thái: 1.250 `saved`, 2.500 `manual_review`, các trạng thái còn lại mỗi loại 1.250. Không có booking thiếu bằng chứng được nâng thành `saved`.
- **56.250** failed/unknown operation được thêm đúng một legacy event; không đổi lỗi gốc. Sequence đúng thứ tự `(created_at,id)`, không nâng version lịch sử, giá trị sequence tiếp theo vượt max hiện tại.
- Khi một reader giữ khóa booking, `lock_timeout=1s` làm transaction migration thất bại an toàn; toàn bộ cột cũ và bảng liên quan giữ nguyên, các cột/bảng mới chưa tồn tại. Lượt thành công dùng `lock_timeout=2s`, `statement_timeout=120s`; đây là thông số rehearsal, chưa phê duyệt cấu hình release.
- Quan sát rewrite bảng operation và khoảng **191 MB WAL** trong cửa sổ migration/probes/assertions của cluster QA; chưa tách riêng lượng WAL do migration. Bộ đo lần đầu không nhận diện đúng phiên migration nên thiếu probe; đã sửa `PGAPPNAME`, reset QA mới rồi chạy lại toàn bộ rehearsal. Giữ bằng chứng lượt chưa đầy đủ trong `migration-load-before-probe-fix/`. Một lỗi tên cột trong seed synthetic cũng đã sửa, transaction seed lỗi được rollback.

Second-pass độc lập chấp nhận kết quả trong phạm vi này. Oracle gồm tám nhóm fixture, không thay thế mọi acceptance về receipt hỏng. Rollback ở đây chỉ là transaction thất bại do lock timeout, không phải rollback bản đã commit/deploy. Các trường provider/outbound bằng 0 trong JSON mô tả phạm vi harness SQL, không phải telemetry đếm network.

Evidence và harness ở thư mục evidence bên dưới: `migration-load-rehearsal.json`, `migration-load-rehearsal.log`, `migration-load-timeout.log`, `migration-load-apply.log`, `migration-load-seed.sql`, `migration-load-rehearsal.py`. Không đổi source hay migration trong vòng đo này, nên các gate code trước đó vẫn gắn đúng hash; không tính rehearsal này là Square Sandbox hoặc Preview.

## 7. Bằng chứng UI và Preview

Ảnh Chromium thật trên **localhost production build + QA**, không phải Preview và không chứng minh SDK/provider save thật:

- [Active desktop](/Users/huytran/nailiq-square-card-delivery-truth-evidence-20260911/ui-saved-en.png)
- [Chưa lưu, mobile tiếng Việt 390 px](/Users/huytran/nailiq-square-card-delivery-truth-evidence-20260911/ui-retry_required-vi-mobile.png)
- [Manual review](/Users/huytran/nailiq-square-card-delivery-truth-evidence-20260911/ui-manual_review-en.png)
- [Reconciliation pending](/Users/huytran/nailiq-square-card-delivery-truth-evidence-20260911/ui-reconciliation_pending-en.png)
- [Link hết hạn](/Users/huytran/nailiq-square-card-delivery-truth-evidence-20260911/ui-expired-vi-mobile.png)
- [Owner exceptions](/Users/huytran/nailiq-square-card-delivery-truth-evidence-20260911/ui-owner-excerpt.png)

Đã xem ảnh thực: không tràn ngang tại viewport kiểm tra; recovery dùng theme/brand và giờ salon; failed/manual/pending không có nhãn active. Phiên ảnh cũ này chưa xác minh iframe Square thật; lượt Computer Use ở mục 11 đã tải/tokenize SDK Sandbox thật. WebKit và Preview vẫn chưa xác minh.

## 8. Rủi ro còn lại

1. Chưa khôi phục được substage provider của incident; chưa sửa booking Production này.
2. Sandbox preflight/save/decline/race/recovery đã PASS theo mục 12. Có ngoại lệ hiển thị token Sandbox qua công cụ; đã thu hồi toàn bộ OAuth authorization cũ và cấp lại quyền tối thiểu, xác minh khóa cũ HTTP 401, khóa mới HTTP 200 ở mục 14. Không gán kết quả Sandbox cho Production.
3. Huy đã duyệt commit/push/draft PR và Preview; trạng thái hiện tại ở mục 14. Preview phải dùng QA/Sandbox và giữ chặn charge/Production; provider notifications theo đúng phạm vi phê duyệt, không giả định OFF.
4. Thẻ lịch sử thiếu durable receipt/policy metadata sẽ vào manual và mất eligibility thu phí. Cần kế hoạch xử lý dữ liệu cũ và lượng exception trước release; không backfill thành công giả.
5. Legacy disabled thiếu binding, receipt hỏng/nhiều matches hoặc identity cấu hình đổi vẫn cần operator xử lý có bằng chứng. Không có override để giải phóng bất chấp unknown; không cam kết mọi manual case tự phục hồi không cần người.
6. Stripe reuse cũ thiếu ownership receipt nên dùng fresh SetupIntent; Stripe reconciliation là giới hạn có trước. Cần provider regression riêng trước release salon Stripe.
7. Exceptions giới hạn 100 booking (có thông báo thêm), tra tối đa 1.000 operation; lịch sử cực lớn có thể thiếu nhãn lần thử của một booking, không ảnh hưởng projection.
8. Đã đo migration/backfill với 10.000 booking và 60.000 operation synthetic: bảo toàn dữ liệu PASS, nhưng reader/writer operation chờ khoảng 4,4 giây. Chưa đo phần cứng, tải đồng thời, phân bố lịch sử hay schema thực tế Production; không cam kết zero downtime. Cần diễn tập bằng runner phát hành thực tế và chốt cửa sổ nâng cấp/timeout trước release.

## 9. Rollback procedure

Hiện chỉ local/QA: giữ evidence rồi có thể bỏ patch ở isolated worktree; không tác động checkout gốc. Không down migration/deploy Production.

Cho release tương lai, chỉ sau phê duyệt:

1. Chốt artifact/hash, schema parity, backup được phép và Preview/Sandbox. Pause capture mới bằng `NAILIQ_CARD_SAVE_DISPATCH_DISABLED=true` trên release được duyệt. Cờ chặn trước claim/provider mutation ở save và Stripe setup; không hủy lịch/xóa receipt.
   Migration phải có transaction boundary và giới hạn chờ khóa/chạy được chốt theo runner phát hành. Rehearsal QA chứng minh lock timeout rollback sạch; không tự bỏ timeout, retry liên tục hoặc dùng kết quả 4,5 giây local để bảo đảm thời gian Production.
2. Nếu lỗi: giữ pause capture, UI reservation/protection và fee guard. Để operation đã dispatch hoàn tất hoặc read-only reconciliation theo lease. Không replay source.
3. Giữ operation/capabilities/receipts/events và customer claim/key/reference/body đầu tiên. Không xóa claim để ép tạo customer dưới key mới. Không DROP lịch sử, không đổi unknown thành failed để ép retry, không sửa projection thành saved bằng tay.
4. Sửa tiến tới bằng app/migration tương thích. **Không chỉ rollback về SHA cũ** vì thiếu binding và có thể khôi phục card-ID-only protection. Rollback schema thực sự cần migration đảo riêng, kiểm kê operation và rehearsal mới; chưa chuẩn bị/chạy trên Production.
5. Trước mở capture: lặp QA save/decline/response-loss/DB-loss/recovery, revoked links, duplicate guards; Huy duyệt mở cờ. Pause gate có unit zero-claim/provider; rollback Production end-to-end chưa diễn tập.

Không SMS/email/call tự động, auto-cancel, charge hoặc refund trong task.

## 10. PASS/FAIL theo evidence class

| Lớp | Trạng thái |
| --- | --- |
| Existing before task | Booking-first commit, capability, idempotency, preparation, reconciliation lease đã có |
| Implemented locally | Đã sửa, chưa commit |
| QA tested | PASS trong phạm vi; thêm backend Square Sandbox và Computer Use thật ở mục 12 |
| Preview verified | NOT VERIFIED |
| Deployed | NO |
| Production verified | NO với hotfix; chỉ audit incident/schema/base SHA read-only |
| P0 release acceptance tổng thể | **FAIL / NOT READY** |

Thư mục evidence: `/Users/huytran/nailiq-square-card-delivery-truth-evidence-20260911`. Không đưa `environment.private.json`, `ui-fixtures.private.json` hoặc stack-start log có QA credentials vào commit/PR.


## 11. Computer Use trên Chrome — SDK thật, backend chặn trước network

Ngày 2026-09-11, kiểm tra trên bản build local trong isolated worktree, Supabase disposable với dữ liệu synthetic và **Square Sandbox Web Payments SDK 1.84.5 thật**. Không dùng thẻ thật. Cấu hình backend dùng token giả và chặn mọi fetch ra ngoài trước network; chỉ SDK trong browser gọi Sandbox. Không chạy CreateCustomer/CreateCard/charge hay gửi SMS/email/call. Đây không phải Preview.

**Lỗi mới đã tái hiện và sửa local:**

1. Form tải lỗi nhưng chọn consent vẫn bật Save; bấm Save im lặng vì cardRef chưa có. Đã thêm trạng thái sẵn sàng theo từng form, khóa Save đúng, nút tải form lại và cleanup lần khởi tạo cũ.
2. Trang lịch đã giữ lại ghi “Card required to confirm”, đổ lỗi thông tin thẻ khi khách chưa nhập được, và gợi ý đổi browser ngay trong Chrome. Đã sửa copy EN/VI theo trạng thái bảo vệ, phân biệt lỗi tải form với lỗi xác minh; WebView guidance chỉ hiện khi thực sự nhận diện WebView.
3. Post-booking STORE tokenize thiếu **billingContact object** mà SDK hiện tại yêu cầu. SDK từ chối trước save dù nhập đủ thẻ. Bổ sung `{}` khi trang recovery không có contact; giữ contact thật đã nhập trong bước confirm. Type STORE bắt buộc object này. Không đổi intent, không bỏ xác minh, không thêm thông tin khách giả vào code.
4. Square trả status `Invalid`/`Error` nhưng allowlist cũ chỉ nhận chữ hoa nên mất phân loại thành OTHER. Đã chuẩn hóa enum an toàn. Lỗi khởi tạo ghi stage và tên lỗi allowlist; dùng `square_error_kind` để không bị bộ lọc secret-code che mất, giữ nguyên bộ lọc privacy.

**Chẩn đoán môi trường, không quy cho incident Production:** HTTP `127.0.0.1` gây `payments_init / WebSdkEmbedError` dù `secure_context=true`. SDK yêu cầu HTTPS ngoài hostname localhost. Chrome chọn IPv6 cho localhost trong khi server chỉ nghe IPv4; cầu nối loopback IPv6 tạm thời giải quyết việc mở trang. Cùng cấu hình đã tải iframe thành công ở localhost; không thay cài đặt mạng/chứng chỉ hệ thống.

**11/11 kiểm tra giao diện theo phạm vi trong `cua-ui-results.json`:** lỗi tải/retry, consent gate, iframe Sandbox thật, nhập thiếu, nhập thẻ synthetic qua tokenization, lỗi giả lập trước customer search, reload, form nhập lại trống, fixture unknown/manual/saved. 11 ca này không tương đương 11 chức năng mới và không cộng vào bộ 784.

Lần nhập synthetic sau sửa tạo operation local `091c8c1b-a91b-4a00-9976-0a2f2dba304d`: `failed`, `square_customer_search_failed`, stage `customer_search`, consent có timestamp, resolution `customer_reentry_required`. Backend boundary ghi đúng **một** lần chặn trước network tại customer search. Điều này cùng nhánh code chỉ gửi khi tokenize OK xác minh đã vượt bước SDK; **không chứng minh Square đã tạo customer/card**. Booking vẫn confirmed/retry_required, không card/customer ID. Reload và mở lại form không tạo operation mới. Fixture unknown giữ nguyên attempt/empty count 0, không phát provider read trong ca này; không gọi đó là test read-timeout.

- [Form Square thật đã tải](/Users/huytran/nailiq-square-card-delivery-truth-evidence-20260911/cua-square-sandbox-form-ready.png)
- [Lỗi tải được xử lý đúng](/Users/huytran/nailiq-square-card-delivery-truth-evidence-20260911/cua-after-form-load-error.png)
- [Nhập thiếu trên SDK thật](/Users/huytran/nailiq-square-card-delivery-truth-evidence-20260911/cua-square-empty-entry-validation.png)
- [Giữ lịch sau lỗi trước provider](/Users/huytran/nailiq-square-card-delivery-truth-evidence-20260911/cua-after-sdk-save-safe-failure.png)
- [Đang đối soát, chưa bảo vệ](/Users/huytran/nailiq-square-card-delivery-truth-evidence-20260911/cua-reconciliation-pending.png)
- [Cần kiểm tra thủ công](/Users/huytran/nailiq-square-card-delivery-truth-evidence-20260911/cua-manual-review.png)
- [Đã bảo vệ — chỉ fixture receipt mô phỏng](/Users/huytran/nailiq-square-card-delivery-truth-evidence-20260911/cua-saved-fixture-only.png)

Đã xem ảnh thực: form, consent và các trạng thái không chồng/tràn ở viewport desktop đã thử. Lượt Computer Use này chưa xác minh thêm mobile/WebKit/locale VI hay Owner UI; bằng chứng cũ giữ riêng. Không lưu ảnh khi trường thẻ đã điền. Kiểm tra app server log và error_logs không thấy số thẻ thử hoặc source token; không suy rộng đây là chứng nhận toàn bộ hệ thống logging.

**Gate bản mới:** 978/978 unit/regression trên 126 files; 66 focused nằm trong số này, gồm 33 helper/lifecycle/diagnostic cases. Next build rồi typecheck tuần tự PASS; lint 8 TS/TSX thay đổi trong lượt này 0 error/0 warning; diff check PASS. Build đã bắt hai lỗi type ở quá trình chỉnh sửa, đã sửa và bản cuối PASS. Review độc lập scoped PASS.

**Còn thiếu:** actual backend CreateCard success/decline, Sandbox response-loss/reconciliation/race, issuer/3DS đa dạng và Preview được duyệt. `{}` được SDK chấp nhận trong ca thử này không bảo đảm mọi issuer xác minh thành công; contact có sẵn vẫn nên được dùng. Deposit CHARGE có hợp đồng riêng chưa được thử/sửa trong lượt này. Không đổi migration ở lượt Computer Use. Không xác định thêm được substage đã mất của incident Production. **Release vẫn FAIL / NOT READY; Deployed NO, Production verified NO.**

Nguồn: [Square STORE verification contract](https://developer.squareup.com/reference/sdks/web/payments/objects/StoreCardVerificationDetails), [tokenization failure statuses](https://developer.squareup.com/reference/sdks/web/payments/objects/ErrorTokenResult), [HTTPS/secure context error](https://developer.squareup.com/reference/sdks/web/payments/errors/WebSdkEmbedError), [Sandbox card testing](https://developer.squareup.com/docs/devtools/sandbox/payments).

## 12. Square Sandbox thật sau khi Huy cho phép thông báo

Huy đã nói rõ: “Tôi chấp nhận cho gởi email sms bạn hãy test đi”. Lần chạy dùng `test_notifications_authorized`: chấp nhận email/SMS có thể phát sinh từ provider trong Sandbox; **không kết luận provider notifications OFF**. Ứng dụng vẫn chặn SMS/email/call, payment/charge và các route ngoài phạm vi card. Không sử dụng thẻ, khách, booking hoặc Square Production. Không commit/push/PR/merge/deploy.

### Kết quả và ranh giới bằng chứng

| Lớp bằng chứng | Kết quả thực tế |
| --- | --- |
| Trước lượt này | 978 unit/regression; 19 integration PostgreSQL với Square giả; 16 SQL scenarios; 23 Chromium UI giả provider; 11 Computer Use chỉ tới SDK và server chặn mạng |
| Square Sandbox backend thật | **7/7 ca PASS** trong `sandbox-backend-run3.json`; recovery-only test được skip ở lượt này, không tính thành ca thứ tám đã chạy |
| Phục hồi operation của lượt bị ngắt | **1/1 PASS**, `sandbox-backend-recovery1.json`: tìm theo reference gốc, 1 GET card, 0 customer/card mutations |
| Unit/regression mới | **996/996 PASS, 126 files**; gồm 44 guard tests, không cộng lặp 44 vào tổng |
| UI Computer Use thật | Chrome + Square Sandbox SDK 1.84.5 + Next production build local + Supabase disposable; các ca bên dưới có screenshot và DB/ledger đối chiếu |
| Build / typecheck / lint cuối | **PASS / PASS / PASS**; lint ba file TypeScript của lượt này 0 errors/warnings; 44 guard tests chạy lại PASS sau sửa narrowing |
| Preview verified | **NO**; chưa được phép phát hành Preview |
| Deployed / Production verified | **NO / NO** |

Bảy ca backend gồm: save thành công + 12 request đồng thời/replay; thẻ bị từ chối; timeout trước mutation; mất phản hồi sau CreateCard; DB timeout trước completion; DB mất phản hồi sau commit; hai booking đồng thời dùng chung một customer. Run3 có **6 CreateCustomer + 7 CreateCard requests**, trong đó có decline; đây không phải bảy thẻ lưu thành công. Mỗi ca response loss và DB-before chỉ CreateCard một lần, chờ thời gian thật khoảng 121 giây rồi GET đúng reference một lần. DB-after đã commit nên hoàn tất idempotently mà không cần provider read.

Computer Use đã trực tiếp kiểm tra:

- Nhập Visa Sandbox trong iframe và bấm Save: Square HTTP 200; booking có card/customer binding, brand, last4, consent timestamp, policy version và operation succeeded; UI hiển thị Card protection active. Reload giữ đúng trạng thái.
- Nhập thẻ Sandbox declined: Square HTTP 400; booking còn nguyên, không protected. Reload giữ nút thử lại; biểu mẫu mới trống và consent chưa chọn. Đổi sang thẻ thử hợp lệ lưu thành công trên cùng booking.
- Timeout trước SearchCustomer: không CreateCustomer/CreateCard; lịch hẹn vẫn được giữ. Nhập thẻ mới sau lỗi thì lưu thành công.
- Mất phản hồi sau Square CreateCard HTTP 200: UI báo đang kiểm tra, không mở iframe mới khi reload. Nút thử lại sau khoảng chờ thực hiện GET reference chính xác, chuyển Card protection active, không CreateCard lần hai.
- DB completion timeout sau Square HTTP 200: UI chưa protected. Nút thử lại sau khoảng chờ phục hồi receipt và booking atomically; không tạo lại thẻ.
- Zero matches: operation do guard test chặn CreateCard được đối soát ba lần bằng GET thật, đúng khoảng chờ và hơn 15 phút từ dispatch. Chuyển failed/customer_reentry_required và booking retry_required; form mới trống, consent chưa chọn, không protected. Không tokenize/lưu thêm sau khi đạt trần 12 writes.
- Owner: danh sách tên viết tắt, thời gian/service và Card required — not saved; tạo link hai lần trả cùng capability, mở được form recovery; Mark reviewed còn sau reload. Truy cập salon QA khác bị chuyển về salon được phép.
- Kích thước điện thoại 390×844: không tràn ngang; trạng thái và link quản lý thẻ vẫn đọc được.

UI ledger có giới hạn bền vững **12 write attempts**, đã dùng 6 CreateCustomer + 6 CreateCard requests, gồm lần bị từ chối. `runId` của UI lấy theo mode tại thời điểm request; một số lượt reconciliation mang tên ca kế tiếp. Phải nối theo `referenceId`/operation, không suy ra ca chỉ từ `runId`. Body SDK được giữ nguyên, không thêm postal code fixture như backend fixed-nonce suite. Kết thúc có **5 GET card** (hai lần tìm thấy receipt, ba lần rỗng). Sáu booking QA đều còn confirmed: năm saved với receipt/consent đầy đủ, một retry_required chưa có thẻ. Không còn operation unknown trong sáu booking này.

### Những lỗi bắt được thuộc bộ thử, đã sửa local

1. Square từ chối email `.test` ở SearchCustomer (`400 / INVALID_VALUE / field=email`). Probe read-only xác nhận `synthetic-UUID@example.com` được chấp nhận. Đổi đúng fixture/guard sang domain dành cho ví dụ và prefix synthetic; không đổi lookup sản phẩm hoặc gán lỗi này cho incident Production.
2. Helper backend gọi reconciliation chưa đến một giây sau dispatch dù RPC yêu cầu hai phút. Đổi sang chờ điều kiện thật bằng SELECT, không chỉnh lùi timestamp/lease. Operation đã tạo được phục hồi riêng trước lượt chạy mới; không replay source.
3. Guard Computer Use giả định sai key `nq:UUID:card`; sản phẩm dùng `UUID:card`. Đã sửa guard theo hợp đồng thật, thêm test từ chối prefix sai. Lần sai này đã tạo một customer nhưng **chưa gửi CreateCard**; operation `83f7306b-a32b-421b-8517-b459e91f935d` đã hoàn tất ba lần đối soát rỗng theo policy, chuyển retry_required an toàn; không ép thành succeeded hoặc phát lại token.
4. Build phát hiện thiếu narrowing kiểu cho mode notification mới; đã sửa đường trả lỗi trong guard. Turbopack local từ chối symlink node_modules nằm ngoài root; dùng lại `next build --webpack` như các lượt build đã được chấp nhận trước đó. Không thay cấu hình Production để che lỗi môi trường này.

Không có lỗi sản phẩm mới được chứng minh từ những thất bại harness trên. Nguyên nhân substage cụ thể của booking Production ban đầu vẫn chưa thể khôi phục từ log cũ.

### Quyền riêng tư và giới hạn của phiên chạy

Tests/diagnostics của app giữ error code allowlist và không ghi source/card secrets. Tuy nhiên **đã có ngoại lệ trong thao tác công cụ**: khi mở mục quyền Sandbox, một phản hồi accessibility đã hiển thị access token và refresh token Sandbox. Không đưa lại các giá trị đó vào báo cáo, repository hoặc journal; file cấu hình riêng dùng mode 0600. Không thể tuyên bố toàn phiên không từng hiển thị secrets. Cần thay các token Sandbox bị hiển thị trước lần tái sử dụng tiếp theo; chưa tự rotate/revoke. Không có credential Production được lấy trong phiên này.

Các ca multiple matches, disabled/invalid receipt và Receptionist dựa trên bằng chứng unit/integration/UI trước đó; không gắn nhãn tất cả là Square thật qua Computer Use. Owner và chặn truy cập salon khác đã được kiểm tra lại trực tiếp trong lượt này. Chưa thử đa dạng issuer/3DS hoặc deposit CHARGE. Không xác minh có email/SMS provider nào được phát hay được nhận; quyền cho phép thông báo không phải bằng chứng delivery.

Evidence root: `/Users/huytran/nailiq-square-card-delivery-truth-evidence-20260911`. Kết quả chính: `sandbox-live-preflight.json`, `sandbox-backend-run3.json[l]`, `sandbox-backend-recovery1.json[l]`, `sandbox-regression.json`, `cua-sandbox-server-boundary.jsonl`, `cua-sandbox-db-checkpoint.json`, `cua-sandbox-ui-results.json`, `sandbox-final-validation.json`, `cua-sandbox-*.png`. Các log thất bại được giữ riêng để phân biệt lỗi harness với kết quả cuối. Rollback không phát sinh ở Production; giữ nguyên quy trình rollback giới hạn ở mục 9. Next QA, launcher, IPv6 bridge và Supabase đã dừng sau khi ghi kết quả; database volumes/journal được giữ. Colima được trả về trạng thái dừng; kết quả kiểm tra ở `sandbox-cleanup.json`.

## 13. Chuẩn bị CI/Preview sau kiểm thử Sandbox

Kiểm tra read-only ngày 2026-09-11T09:43Z: cả 63 hash ở checkpoint trước còn nguyên; nhánh `fix/square-card-delivery-truth-20260911` chưa có PR. GitHub `main` vẫn ở `15fe1091fd71eda4a67704d08e5ab535967e5904`; CI và E2E của **main** đã thành công, không phải CI của hotfix. Metadata Vercel xác nhận deployment Production `dpl_9D4tsyrSVVDBDAbkg5Hxmqx1FAJX` READY, target production, cùng SHA; không gọi lại API nghiệp vụ hoặc Square Production.

**Thiếu kiểm tra trong CI:** workflow `migration-history-rehearsal.yml` áp dụng mọi migration mới nhưng chưa gọi `scripts/security/rehearse-card-delivery-truth.sql`. Đã thêm script vào bộ lọc PR và bước chạy SQL trên Supabase disposable sẵn có. YAML parse, shell syntax và đường dẫn trigger PASS. Script SQL giữ đúng hash đã qua 16/16 scenario; không sửa schema/source và không chạy lại provider. Chưa chạy CI từ xa. Thay đổi mới ở lượt này chỉ workflow và tài liệu; worktree hiện 64 file.

**Chặn Preview đã xác minh bằng metadata:** Vercel có một biến `NEXT_PUBLIC_SUPABASE_URL` mặc định áp dụng cho cả production và preview; nhánh hotfix không có override QA. Không đọc/in giá trị biến hoặc credential. Không suy diễn rằng Preview đã truy cập Production; chưa tạo Preview. Trước push phải cấu hình riêng đúng nhánh hoặc chặn auto-preview cho tới khi cấu hình được xác minh. Không sao chép toàn bộ environment Production và không sửa các biến đang phục vụ salon live.

Bản PR và gói hành động đề xuất đã chuẩn bị local tại `release-pr-draft.md`, `release-approval-package.md` trong evidence. Phạm vi xin duyệt gồm cấu hình QA/Preview riêng, xử lý khóa Sandbox đã hiển thị trước khi gọi lại provider, commit/push một lô và mở draft PR. Merge/deploy/migration Production vẫn ngoài phạm vi. Cần chốt QA DB/schema và quyền tối thiểu của khóa mới, rồi xác minh cấu hình trước push; không coi tên biến là bằng chứng cấu hình sử dụng được.

Evidence mới: `release-ci-wiring-validation.json`, `release-preview-isolation.json`, `release-preflight-vercel-metadata.json`. Không thêm các file cấu hình riêng vào Git. Không chạy lại build/unit vì source và dependency không đổi; bằng chứng 996 test/build/typecheck trước vẫn gắn đúng hash source. Bước YAML mới chỉ được kiểm tra local, không được gắn nhãn remote CI PASS.

## 14. Gói phát hành nhánh QA đã được Huy duyệt

Huy trả lời “N” cho câu hỏi duyệt tách Preview sang QA, thay khóa Sandbox đã hiển thị, commit/push nhánh riêng và mở PR chạy CI/Preview. Đây là phê duyệt gói đó; không bao gồm merge, deploy/migration Production hoặc thu tiền. Các mục 11–13 ghi lịch sử tại thời điểm trước phê duyệt.

- **Hosted QA:** dùng nhánh disposable `osdqutwunokiielbairj`, được tạo `with_data=false`. Đã áp dụng hai migration card continuation/truth với transaction và lock timeout 5 giây, statement timeout 60 giây. Cả 503 tên migration của repository đều có trong history QA (một số có timestamp khác). Không đồng nhất việc khớp tên với chứng minh mọi function body; bộ SQL 16 tình huống đã thực sự chạy lại thành công và rollback trên QA này.
- **Bảo toàn QA cũ:** trước tạo fixture mới, 3 salon và 14 booking giữ nguyên checksum, bỏ cột projection mới khi so sánh booking; 0 operation cũ. Hai bảng mới bật RLS/FORCE RLS, anon/authenticated không được SELECT. Advisor có hai INFO về bảng service-only không có policy, đúng thiết kế fail-closed; 17 cảnh báo RPC public/authenticated nằm ở các function không được hotfix sửa, chưa coi đó là audit toàn hệ thống PASS.
- **Sandbox credential remediation:** revoke toàn bộ authorization của đúng QA app/account, rồi reauthorize với `MERCHANT_PROFILE_READ`, `CUSTOMERS_READ`, `CUSTOMERS_WRITE`, `PAYMENTS_READ`, `PAYMENTS_WRITE`. Khóa cũ bị từ chối HTTP 401; khóa mới HTTP 200, đúng app/merchant, location CAD ACTIVE. Refresh credential đã thay. Toàn bộ webhook subscription vẫn disabled. Không thay credential Production; giá trị khóa chỉ nằm trong tệp riêng 0600 và cấu hình QA.
- **Fixture riêng:** tenant `card-truth-preview-20260911`, một Owner tạo qua admin API không gửi mail, ba booking synthetic: success, decline/retry, awaiting-card. Integration chỉ Sandbox, mọi sync/deposit OFF. App outbound và fee dispatch sẽ được chặn bằng biến riêng nhánh; giới hạn lượt Preview dự kiến 2 customer requests và 3 card requests, không charge.
- **Điều kiện Vercel thực tế:** API yêu cầu nhánh tồn tại trên GitHub trước khi cho đặt environment theo nhánh. Yêu cầu cấu hình đã bị từ chối, chưa tạo biến nào. Vì vậy `vercel.json` chặn auto-deploy chỉ nhánh hotfix này; main và nhánh khác giữ mặc định. Sau push, phải tạo/read-back QA overrides rồi mới chủ động tạo Preview. Cách chặn được xác minh theo [Vercel Git Configuration](https://vercel.com/docs/project-configuration/git-configuration#git.deploymentenabled).
- **Tại checkpoint trước publish:** chưa có candidate CI hoặc hosted Preview PASS. Mọi kết quả main CI trước đó vẫn chỉ là baseline. Cập nhật URL/SHA và bằng chứng từ xa sau khi chạy.

Evidence riêng: `sandbox-credential-remediation.json`, `sandbox-live-preflight.json`, `hosted-preview-fixture-setup.json`, `hosted-qa-validation.json`. Không đưa private environment, capability, credential hoặc output chưa che vào Git/PR.

## Phụ lục — file thay đổi trong worktree

- `.github/workflows/migration-history-rehearsal.yml` — chạy rehearsal SQL card delivery trong CI.
- `vercel.json` — chặn auto-deploy chỉ nhánh hotfix trước khi QA overrides được xác minh.

- [docs/decisions.md](/Users/huytran/nailiq-square-card-delivery-truth-20260911/docs/decisions.md)
- [docs/qa/square-card-delivery-truth-2026-09-11.md](/Users/huytran/nailiq-square-card-delivery-truth-20260911/docs/qa/square-card-delivery-truth-2026-09-11.md)
- [docs/qa/square-card-sandbox-certification.md](/Users/huytran/nailiq-square-card-delivery-truth-20260911/docs/qa/square-card-sandbox-certification.md)
- [scripts/qa-square-card-sandbox-guard.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/scripts/qa-square-card-sandbox-guard.ts)
- [scripts/security/rehearse-card-delivery-truth.sql](/Users/huytran/nailiq-square-card-delivery-truth-20260911/scripts/security/rehearse-card-delivery-truth.sql)
- [src/app/api/booking/group-create/route.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/app/api/booking/group-create/route.ts)
- [src/app/api/booking/group-pricing-routes.spec.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/app/api/booking/group-pricing-routes.spec.ts)
- [src/app/api/booking/save-card-context/route.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/app/api/booking/save-card-context/route.ts)
- [src/app/api/booking/square-noshow-config/route.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/app/api/booking/square-noshow-config/route.ts)
- [src/app/booking/save-card/layout.tsx](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/app/booking/save-card/layout.tsx)
- [src/app/booking/save-card/page.tsx](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/app/booking/save-card/page.tsx)
- [src/app/dashboard/[slug]/no-show-protection/page.tsx](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/app/dashboard/[slug]/no-show-protection/page.tsx)
- [src/components/booking/BookingFlowDonePanel.tsx](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/components/booking/BookingFlowDonePanel.tsx)
- [src/components/booking/BookingGroupFlow.tsx](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/components/booking/BookingGroupFlow.tsx)
- [src/components/booking/BookingSequenceFlow.tsx](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/components/booking/BookingSequenceFlow.tsx)
- [src/components/booking/CardProtectionRecovery.tsx](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/components/booking/CardProtectionRecovery.tsx)
- [src/components/booking/ConfirmStepCardCapture.tsx](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/components/booking/ConfirmStepCardCapture.tsx)
- [src/components/booking/NoShowCardCapture.tsx](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/components/booking/NoShowCardCapture.tsx)
- [src/components/booking/NoShowCardCaptureStripe.tsx](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/components/booking/NoShowCardCaptureStripe.tsx)
- [src/components/dashboard/CardProtectionExceptions.tsx](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/components/dashboard/CardProtectionExceptions.tsx)
- [src/components/receptionist/BookingDetailDrawer.tsx](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/components/receptionist/BookingDetailDrawer.tsx)
- [src/components/receptionist/ReceptionistCenter.tsx](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/components/receptionist/ReceptionistCenter.tsx)
- [src/shared/booking/__tests__/bookingCardManagement.spec.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/booking/__tests__/bookingCardManagement.spec.ts)
- [src/shared/booking/__tests__/cardDeliveryTruth.qa.spec.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/booking/__tests__/cardDeliveryTruth.qa.spec.ts)
- [src/shared/booking/__tests__/cardDeliveryTruth.sandbox.qa.spec.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/booking/__tests__/cardDeliveryTruth.sandbox.qa.spec.ts)
- [src/shared/booking/__tests__/cardProtectionExceptions.spec.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/booking/__tests__/cardProtectionExceptions.spec.ts)
- [src/shared/booking/__tests__/reconcileBookingCardSaveOperations.spec.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/booking/__tests__/reconcileBookingCardSaveOperations.spec.ts)
- [src/shared/booking/__tests__/settleCommittedBookingCardManagement.spec.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/booking/__tests__/settleCommittedBookingCardManagement.spec.ts)
- [src/shared/booking/bookingCardManagement.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/booking/bookingCardManagement.ts)
- [src/shared/booking/bookingCardRecovery.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/booking/bookingCardRecovery.ts)
- [src/shared/booking/cardProtection.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/booking/cardProtection.ts)
- [src/shared/booking/cardProtectionExceptionActions.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/booking/cardProtectionExceptionActions.ts)
- [src/shared/booking/persistExistingSquareCardReceipt.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/booking/persistExistingSquareCardReceipt.ts)
- [src/shared/booking/reconcileBookingCardSaveOperations.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/booking/reconcileBookingCardSaveOperations.ts)
- [src/shared/booking/recoverBookingCardAction.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/booking/recoverBookingCardAction.ts)
- [src/shared/booking/sendBookingConfirmationEmail.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/booking/sendBookingConfirmationEmail.ts)
- [src/shared/booking/settleCommittedBookingCardManagement.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/booking/settleCommittedBookingCardManagement.ts)
- [src/shared/dashboard/loadReceptionistCenterData.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/dashboard/loadReceptionistCenterData.ts)
- [src/shared/i18n/booking/en.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/i18n/booking/en.ts)
- [src/shared/i18n/booking/vi.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/i18n/booking/vi.ts)
- [src/shared/integrations/payments/cardDeliveryFailure.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/integrations/payments/cardDeliveryFailure.ts)
- [src/shared/integrations/payments/index.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/integrations/payments/index.ts)
- [src/shared/integrations/payments/square.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/integrations/payments/square.ts)
- [src/shared/integrations/payments/types.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/integrations/payments/types.ts)
- [src/shared/integrations/square/__tests__/cardCustomerClaim.spec.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/integrations/square/__tests__/cardCustomerClaim.spec.ts)
- [src/shared/integrations/square/__tests__/cardDeliveryTruth.spec.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/integrations/square/__tests__/cardDeliveryTruth.spec.ts)
- [src/shared/integrations/square/__tests__/customerCreateIdempotency.spec.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/integrations/square/__tests__/customerCreateIdempotency.spec.ts)
- [src/shared/integrations/square/cardCustomerClaim.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/integrations/square/cardCustomerClaim.ts)
- [src/shared/integrations/square/client.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/integrations/square/client.ts)
- [src/shared/integrations/square/noshow.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/integrations/square/noshow.ts)
- [src/shared/noshow/__tests__/lateCancellationPolicy.spec.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/noshow/__tests__/lateCancellationPolicy.spec.ts)
- [src/shared/noshow/__tests__/noShowProtectionPageAccess.spec.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/noshow/__tests__/noShowProtectionPageAccess.spec.ts)
- [src/shared/noshow/lateCancellationPolicy.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/noshow/lateCancellationPolicy.ts)
- [src/shared/noshow/noShowDashboardActions.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/noshow/noShowDashboardActions.ts)
- [src/shared/noshow/saveNoShowCardAction.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/noshow/saveNoShowCardAction.ts)
- [src/shared/security/__tests__/cardManagementExposure.spec.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/security/__tests__/cardManagementExposure.spec.ts)
- [src/shared/security/__tests__/squareCardSandboxGuard.spec.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/security/__tests__/squareCardSandboxGuard.spec.ts)
- [src/shared/voiceai/toolExecutor.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/voiceai/toolExecutor.ts)
- [supabase/migrations/20260911040747_square_card_delivery_truth.sql](/Users/huytran/nailiq-square-card-delivery-truth-20260911/supabase/migrations/20260911040747_square_card_delivery_truth.sql)

- [src/shared/booking/squareCardForm.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/booking/squareCardForm.ts)
- [src/shared/booking/__tests__/squareCardForm.spec.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/booking/__tests__/squareCardForm.spec.ts)
- [src/shared/security/__tests__/squareBuyerVerificationBoundary.spec.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/security/__tests__/squareBuyerVerificationBoundary.spec.ts)
- [src/shared/security/__tests__/squareCardCaptureUxBoundary.spec.ts](/Users/huytran/nailiq-square-card-delivery-truth-20260911/src/shared/security/__tests__/squareCardCaptureUxBoundary.spec.ts)
