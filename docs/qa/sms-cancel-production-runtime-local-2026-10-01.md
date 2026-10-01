# P1-01 — Hủy hẹn bằng SMS qua HTTP và database local thật

Ngày kiểm tra: 01/10/2026. Checkpoint cuối **B66 — TESTED LOCALLY, PASS**.
Ngày 22 **chưa đóng**; Master Plan **NOT PROVEN**.

## Phạm vi và build

HEAD `e2680aa7a779448940ba597317e908c503089a66`, kèm bản gộp local chưa
publish đã được kiểm kê từ B57–B61. Không sửa code ứng dụng, migration,
feature flag hosted, ACL hay chính sách trong lượt này. Chỉ bổ sung harness
local và báo cáo. Giữ nguyên bốn file staged bàn giao và các thay đổi khác.

Tái sử dụng build default Turbopack đầy đủ đã PASS ở B60; chạy `next start`
production-mode **local**, không phải deployment Production. Bật adapter
`NAILIQ_ATOMIC_INBOUND_SMS_CANCEL=true` chỉ trong process test local, giữ các
kill switches SMS/email/call/payment OFF. Dùng clone riêng từ database
synthetic B54; không sao chép dữ liệu Production. Không có auth user thật.

Luồng thực: HTTP → Next route/body parser → đọc token synthetic từ database
→ kiểm HMAC thật → RPC qua PostgREST thật → PostgreSQL 17.6 và trigger thật.
Không mock API, credential lookup, validator hoặc database. Gateway chỉ cho
app đọc token và gọi RPC hủy hẹn; truy vấn legacy không nằm trong allowlist.
Đường Data API kiểm quyền đi trực tiếp vào PostgREST loopback với JWT local.
Mọi kết nối ngoài loopback bị chặn. Không gọi Twilio, cron hoặc provider.

## Kết quả thật

**19/19 ca PASS**; 34 request inbound HTTP và 5 request kiểm quyền Data API.
Không tính số request retry thành số ca độc lập. Không có route DB ngoài
allowlist hoặc kết nối ngoài bị thử. Các phép đo này không phải UI QA hay
SMS giao tới điện thoại.

| Tình huống | Kết quả |
| --- | --- |
| HMAC sai | 403; không đổi domain/receipt/queue |
| Hủy đúng | 200; hủy đúng lịch, một event hủy, một log inbound và một receipt |
| Gửi lại nguyên SID | Không đổi timestamp, không hủy lịch kế tiếp |
| Cùng SID đổi body / From / To | Ba ca 503; không thay receipt hoặc chọn lại lịch |
| Account hoặc sender không đúng cấu hình | Hai ca 503; không ghi receipt |
| SID không hợp lệ | 503; không ghi dữ liệu |
| Không tìm thấy lịch, rồi xuất hiện lịch mới | Receipt `not_found` giữ nguyên; retry không hủy lịch mới |
| Một số có lịch tại hai salon, salon thứ hai ngoài năm lịch đầu | Không hủy bất kỳ lịch nào; receipt `ambiguous_salon` |
| Sáu request đồng thời cùng SID | Một commit/receipt/event hủy; lịch kế tiếp không đổi |
| Đã commit nhưng phản hồi 200 bị mất | Proxy bỏ đúng một phản hồi; retry không nhân dữ liệu hoặc đổi lịch |
| Lỗi unique ở log cuối giao dịch | 503; domain, event, promotion, queue và receipt hoàn tác cùng nhau; sửa riêng collision synthetic rồi retry đúng một lần |
| Writer khác đã hủy / đổi giờ / bắt đầu dịch vụ trong lúc SMS chờ lock | Ba ca quan sát lock overlap thật; lưu `already_cancelled` hoặc `booking_changed`; retry không chọn lịch kế tiếp |
| anon/authenticated gọi RPC hoặc đọc private receipt | Bốn request bị từ chối bởi PostgREST/DB thật |
| service_role đọc private receipt trực tiếp | 403; chỉ RPC được phép |
| Content type sai | 400 trước khi đọc token |

Snapshot đầy đủ còn kiểm queue/audit của tenant synthetic sau từng retry,
kể cả fault injection cuối giao dịch. `booking_notifications.status=sent`
trong RPC là bookkeeping xử lý **inbound**, không chứng minh gửi SMS ra ngoài.
TwiML được test tại HTTP, không chuyển tới Twilio để phát tin.

## Trigger, bảo toàn và teardown

- Một lần hủy tạo event bảo vệ `terminal_booking_transition_authorized`
  và event domain `booking_cancelled`; chỉ event domain được đếm là hủy hẹn.
- Trigger email khách tạo outbox/event; tất cả hàng mới đều `suppressed`,
  `recipient_missing`, attempt 0 và không provider receipt.
- Trigger thông báo chủ tiệm tạo queue `pending`/`suppressed`; toàn bộ hàng
  của fixture có attempt 0 và provider receipt count 0. Không có worker/cron
  chạy; không đổi Production hoặc gửi thư.
- 265 bảng ngoài chín bảng domain/receipt/audit/queue giữ nguyên fingerprint
  sau khi khởi tạo fixture. Trong các bảng được phép thay đổi, toàn bộ hàng
  nguồn ngoài hai tenant fixture giữ nguyên. 274 bảng database nguồn và root
  database rỗng không đổi. Source digest khớp B60/B61.
- Cuối lượt: 9 command receipts, 9 booking events của fixture (gồm event
  guard và domain), 0 auth users, 0 SMS outbound attempts, 0 deadlocks.
- Process Next, hai proxy và container PostgREST riêng đã dừng. Exit 143 của
  Next là SIGTERM teardown chủ động. Các clone local được giữ làm bằng chứng,
  không dọn/xóa mù database hoặc dữ liệu thật.

## Các lượt chưa đạt — giữ nguyên bằng chứng

1. B62 dừng preflight: sandbox không truy cập Docker socket; chưa tạo clone
   hoặc chạy ca HTTP. B63 chạy bằng quyền execution được hệ thống chấp nhận.
2. B63: HMAC case PASS nhưng assertion đếm tổng event thành một bị FAIL.
   SQL read-only xác minh hai loại event khác nhau; sửa bộ đếm harness,
   không sửa trigger ứng dụng để làm xanh test.
3. B64: 19 ca chức năng PASS nhưng preservation FAIL vì chưa khai báo hai
   bảng customer transition email thuộc tác động trigger dự kiến.
4. B65: 19 ca chức năng PASS nhưng preservation FAIL vì còn queue chủ tiệm
   và `system_audit`. Đã kiểm kê tất cả bảng thay đổi và đọc trigger; B66
   kiểm cả inherited rows, suppressed states và attempt/receipt bằng 0.

Không xóa B62–B65, không gọi các lượt đó là PASS toàn bộ hoặc CI retry cùng
code. Query diagnostic đầu dùng nhầm cột `status` trên bảng event bị từ chối;
đã đọc metadata và query đúng `transition`, không sửa schema.

## Lệnh và artifact

```sh
NODE_OPTIONS=--require=/private/tmp/nailiq-masterplan-combined-local-ojeco5/network-guard.cjs node /private/tmp/nailiq-current-main-combined-iBPOnd/sms-cancel-http-b66.mjs
node --check /private/tmp/nailiq-current-main-combined-iBPOnd/sms-cancel-http-b66.mjs
NODE_OPTIONS=--require=/private/tmp/nailiq-masterplan-combined-local-ojeco5/network-guard.cjs ./node_modules/.bin/vitest run src/app/api/twilio/inbound/route.spec.ts src/app/api/twilio/inbound/route.atomic-cancel.spec.ts src/app/api/twilio/inbound/route.booking-truth.spec.ts src/shared/reminders/__tests__/smsConsentSuppression.spec.ts src/shared/reminders/__tests__/inboundSmsCommand.spec.ts
npm run typecheck
git diff --check
git diff --cached --check
```

Không chạy lại mù: clone đã tồn tại; artifact write-once. Các harness,
`sms-cancel-http-b62.json` tới `b66.json`, log tương ứng và preservation
receipt `combined-sms-cancel-evidence-b66.json` nằm tại
`/private/tmp/nailiq-current-main-combined-iBPOnd`. Closeout ghi kết quả thật
của contract/typecheck/lint và SHA-256 của báo cáo, artifact, file bàn giao.

PR #1441 được đọc lại ở lượt này: OPEN/Draft, exact head e2680, 24 checks
thành công và hai skipped. Đây là head **đã publish trước**, không phải CI
chứng nhận bản gộp dirty local hoặc deployment Production mới.

## Điều chưa chứng minh và bước tiếp

Chưa chạy hosted QA/migration cho bản gộp, chưa provider delivery, reminder
do scheduler thật, carrier STOP/START, physical-device UI hoặc pilot người
mới tại hai Hi-Lite đủ 7–14 ngày. B66 không có waiter đủ điều kiện, nên không
chứng minh background dispatch promotion trên runtime HTTP này. Bằng chứng
promotion/resource local trước đó có phạm vi riêng, không suy rộng.

Tiếp theo là review/publish bản gộp và áp đúng bốn migration pending vào QA
cô lập theo phạm vi được phê duyệt đích danh, rồi hosted QA/Preview. Giữ PR
Draft; không tự suy ra phê duyệt merge, Production hoặc gửi provider từ
việc đạt local PASS. Ngày 22 và toàn Master Plan vẫn chưa đóng.

**Chưa commit, push, hosted migration, deploy hoặc thay đổi hai salon Live.
Không gửi SMS/email, không gọi provider và không tạo/hủy booking thật.**
