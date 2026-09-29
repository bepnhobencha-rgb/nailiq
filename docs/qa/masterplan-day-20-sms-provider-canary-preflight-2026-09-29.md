# Master Plan — Ngày 20: tiền kiểm SMS và một phép thử Twilio Console

Ngày 29/09/2026 theo giờ Vancouver. Tiếp nối Day 12–17 synthetic SMS QA
và Day 19 OTP Production read-only. Phần tiền kiểm ban đầu không gửi SMS;
phép thử một tin trực tiếp bằng Twilio Console theo phê duyệt riêng được ghi
ở cuối. Tin đó không phải bằng chứng luồng SMS của ứng dụng NailIQ.

## Quan sát hiện thời

- Vercel project QA cô lập `nailiq-p1-01-waitlist-qa-20260914`: deployment
  `dpl_4GnXHhzLuqGPtxkAdBfVKCjLKgjg` đã `Ready` trong lần tiền kiểm ban
  đầu, không phải project Production `nailiq`. Kiểm tra lại danh sách Vercel
  trong lượt này cho thấy deployment mới hơn
  `dpl_EUJkLcSqNWYEtkTH73RZCE7bDBFN` cũng `READY` (28/09 09:45 UTC).
  Không suy ra env snapshot của deployment mới từ project env hoặc bản cũ.
- Đọc Preview environment chỉ trong bộ nhớ, không in secret: Supabase public
  và internal URL trỏ QA `uhpzafoiifupyypkcwln`;
  `DISABLE_OUTBOUND_SMS=1`, `DISABLE_OUTBOUND_EMAIL=1`,
  `DISABLE_OUTBOUND_CALLS=1`; payment workers và Smart Checkout provider
  reads đều `0`. Không có `TWILIO_AUTH_TOKEN`, `TWILIO_ACCOUNT_SID` hoặc
  `TWILIO_PHONE_NUMBER` trong Preview environment. Đây là trạng thái biến
  hiện hành của project; không suy ngược rằng snapshot của một deployment
  cũ có cùng mọi giá trị.
- Supabase QA read-only: `platform_settings` platform row **0**, SMS consent
  events **0**, SMS attempts **0**, Twilio status receipts **0**. Không đọc
  token, số điện thoại hoặc dữ liệu cá nhân.
- Code `sendSmsReminder` yêu cầu durable attempt, salon policy, STOP/START
  state, Twilio credentials và status callback trước provider. Kill switch
  chặn Preview QA hiện tại. Số hư cấu 555 và salon đánh dấu test cũng bị
  chặn, nên không thể coi việc bật một biến là canary an toàn.

## Kết luận

**PASS:** Môi trường QA hiện tại vẫn fail-closed và không thể vô tình gửi SMS
qua đường `sendSmsReminder` trong phạm vi đã kiểm. Bài callback synthetic
Day 15–17 không cần lặp lại.

**NOT PROVEN / chưa đóng P1-01:** một SMS thật được provider accepted,
terminal callback được áp đúng một lần, recipient thực tế nhận tin và
STOP/START của provider ngăn lượt tiếp theo. Không gửi SMS/OTP, không gọi
API gửi của provider hoặc cron, không đổi QA/Production hay hai salon Live.

## Cập nhật sau khi có recipient thử

Huy đã chỉ định một số Canada do anh cung cấp (chỉ ghi dạng masked `+1…0738`
trong hồ sơ này) và đồng ý giới hạn một SMS. Đây là phạm vi recipient, **không**
tự biến môi trường QA thành đường gửi hợp lệ. Sau khi Huy tự đăng nhập, Codex
Browser đã vào Twilio Console và kiểm tra **chỉ đọc**:

- Tài khoản chính có một số Canada hiển thị khả năng SMS; điều này chưa chứng
  minh một tin cụ thể sẽ được provider chấp nhận hay giao đến recipient.
- Danh sách subaccount trạng thái Open chỉ có `HI LITE HEAD SPA` (Active),
  không có subaccount QA cô lập được xác minh.
- Số Canada của tài khoản chính đang định tuyến webhook SMS/voice vào
  `nailiq.ca` với slug QA. Đây là domain Production, không phải endpoint Preview
  cô lập; không dùng cấu hình này làm canary QA mặc nhiên.
- Trang cấu hình số không chứng minh outbound status callback. Source hiện có
  hỗ trợ gửi `StatusCallback` theo từng tin và có route xác thực chữ ký tại
  `/api/twilio/status`, nhưng chưa có provider acceptance/terminal receipt QA.

Theo [tài liệu Twilio về message-specific status callback](https://www.twilio.com/docs/messaging/guides/track-outbound-message-status),
không cần đặt delivery-status callback ở cấu hình số nếu mỗi outbound Message
đã truyền `StatusCallback`; NailIQ truyền tham số này trong `sendSmsReminder`.
Do đó điểm chưa chứng minh là **URL callback thực tế của deployment QA, chữ ký
với credential của đúng account, và durable receipt**, không phải chỉ thiếu một
ô cấu hình trong Console. `bindSmsAttemptToStatusCallback` hiện chấp nhận URL
tường minh hoặc fallback từ runtime; trước canary phải chứng minh URL cuối cùng
trỏ đúng QA, không phải `nailiq.ca`.

Không đọc/chép Auth Token hoặc API key, không đổi cấu hình và không gửi SMS.

Twilio xác nhận test credentials không nối đến số thật và không phát status
callback, nên không thể dùng chúng làm bằng chứng điện thoại nhận SMS hoặc
callback thật. Nguồn: https://www.twilio.com/docs/iam/test-credentials.

**BLOCKED tại cổng provider:** quyền truy cập Console đã có, nhưng ở thời điểm
tiền kiểm ban đầu chưa có sender/subaccount QA cô lập và đường callback/receipt
thật đã xác minh. Subaccount được tạo ở cập nhật ngay dưới; sender và callback
vẫn thiếu. Giữ nguyên `DISABLE_OUTBOUND_SMS=1`; không gửi một SMS chỉ để tạo
kết quả xanh.

## Cập nhật sau phê duyệt tạo subaccount QA

Twilio Console đã tạo và hiển thị **Active** cho `NailIQ P1-01 SMS QA
2026-09-29` trong danh sách subaccounts của tài khoản chính. Đây là thay đổi
duy nhất ở Twilio trong lượt này. Subaccount `HI LITE HEAD SPA` vẫn hiển thị
riêng, Active. Không ghi Account SID hoặc token vào tài liệu.

Theo [bảng giá Canada hiện hành của Twilio](https://www.twilio.com/en-us/sms/pricing/ca),
local long-code thuê mới niêm yết **$1.15/tháng**; SMS outbound long-code
**$0.0083/segment**, cộng carrier fee theo nhà mạng. Đơn vị tiền trên trang
giá, giá thực tế và khả năng cấp số phải được xác nhận lại ở checkout;
**chưa mua số**, chưa phát sinh cước gửi.
Subaccount cô lập là điều kiện cần, chưa đủ: còn thiếu sender SMS riêng,
credential và callback QA đúng môi trường, allowlist recipient và durable
receipt. Không chuyển số đang dùng ở parent/Hi-Lite sang QA.

## Kiểm tra source và synthetic bổ sung trong lượt này

- Ở checkpoint tiền kiểm ban đầu: checkout `d350d870286335797f0093048a98783c3ccb5484`,
  nhánh `qa/day19-otp-production-readonly-20260929`. Hai report Day 19/20
  lúc đó là file chưa commit; giữ nguyên các thay đổi khác.
- `npx vitest run` trên nhóm SMS delivery truth, signed callback, consent và
  dispatcher: **6 test files / 45 tests PASS**. File `twilioSms.test.ts` dùng
  runner riêng và không được Vitest thu nhận; không cộng nó vào 45 tests. Không
  chạy runner riêng vì bài đó đi qua bước claim attempt trước kill switch và
  không cần chạm bất kỳ database nào để hoàn tất tiền kiểm này.
- `npm run typecheck`: **PASS**.
- `sendSmsReminder` tạo attempt trước khi qua các guard; provider chỉ được gọi
  sau kill switch, template/salon policy, consent, credential và callback URL.
  Đây là kiểm tra source + mocked tests, không phải chứng cứ Preview runtime.
- `getTwilioAuthToken` ưu tiên `platform_settings`, fallback env. QA trước đó có
  0 platform row; để xác thực callback của subaccount tương lai phải kiểm lại
  credential/runtime đúng account, không được dùng token Production.
- Vercel connector đã xác nhận deployment QA mới nhất `READY`, nhưng công cụ
  chỉ-đọc hiện có không trả env snapshot hay URL callback runtime của đúng
  deployment. Vì vậy cổng callback QA vẫn **NOT PROVEN**, không được lấp bằng
  dự đoán từ source hoặc deployment cũ.
- Twilio [xác nhận](https://www.twilio.com/docs/messaging/guides/outbound-message-status-in-status-callbacks)
  không gửi callback cho trạng thái ban đầu của Message; chỉ provider accepted
  hoặc queued chưa chứng minh delivered. Lượt canary phải chờ terminal receipt.

**Kết quả checkpoint tiền kiểm:** local **PASS**, canary provider **BLOCKED / NOT
PROVEN**. Lúc đó chỉ tạo subaccount QA đã được duyệt; không đổi
cấu hình/sender, không gửi SMS và không thay dữ liệu/Production. Chưa commit
hoặc push tại checkpoint này.

## Cổng còn thiếu trước đúng một canary

1. Recipient thử E.164 và giới hạn tối đa **một** SMS: đã có; không ghi số đầy
   đủ vào repo, logs hoặc telemetry.
2. Subaccount QA: **đã tạo, Active**. Chọn một sender SMS riêng đủ điều kiện
   cho vùng nhận sau khi có phê duyệt chi phí; không sao chép Production
   credential hoặc bật cờ của salon Live.
3. Thiết kế đường canary cô lập có recipient allowlist, command/idempotency
   receipt và rollback; không nới kill switch chung của Preview, không bỏ
   guard cho salon test. Review đường gửi và callback trước thao tác provider.
4. Sau phê duyệt cấu hình/gửi cụ thể, kiểm accepted SID, terminal callback,
   durable receipt, không trùng, trải nghiệm recipient; trả mọi QA switch về
   OFF và thu hồi credential tạm nếu đã tạo.

Một SMS outbound được giới hạn ở đây **không thể tự chứng minh** STOP/START,
reminder 24h/3h, hay toàn P1-01. Inbound STOP/START cần kiểm riêng sau khi có
sender QA, webhook inbound QA và phạm vi phê duyệt riêng; không thử bằng số
đang nối vào domain Production. Twilio có thể tự chặn lượt gửi sau STOP, nhưng
NailIQ còn phải nhận đúng trạng thái consent có thể kiểm chứng. Không dùng
`accepted`/`sent` thay cho `delivered` và không coi thiếu callback là hết chỗ
hoặc giao thành công.

Day 20 mới là tiền kiểm, không được ghi là nghiệm thu SMS 100%.

## Yêu cầu tái sử dụng số Twilio cũ (29/09)

Huy muốn dùng số Canada đang có thay vì thuê số mới. Kiểm tra chỉ-đọc trong
Twilio Console xác nhận số này vẫn thuộc **tài khoản chính**, không thuộc
subaccount QA mới. Số đang có webhook inbound SMS và voice trỏ về
`nailiq.ca` (Production domain) với slug QA. Nhật ký outbound của riêng số
cho thấy đã có nhiều lượt gửi trước đây; bản ghi mới nhất hiển thị là
31/08/2026. Nhật ký đó **không chứng minh** số không còn được luồng Production
hoặc salon Live tham chiếu hôm nay. Không ghi recipient hoặc nội dung SMS.

Theo tài liệu Twilio về chuyển số giữa account/subaccount, chuyển quyền sở
hữu sẽ lấy số khỏi account nguồn, và cấu hình webhook/opt-out/registration có
thể cần thiết lập lại. Vì vậy **không chuyển số sang QA subaccount**, không
đổi inbound webhook và không sao chép credential chính sang Preview chỉ để
gửi nhanh. Nếu muốn tái sử dụng, đường an toàn là xác minh số không phục vụ
hai salon Live, sau đó thiết kế canary outbound từ đúng account sở hữu số với
recipient allowlist, kill switch độc lập, callback ký xác thực đến QA và
durable receipt; mọi thay đổi runtime/gửi thật cần kiểm chứng riêng trước khi
thực hiện. Không có bằng chứng đáp ứng các cổng này trong lượt hiện tại.

Nguồn Twilio: https://www.twilio.com/docs/iam/api/subaccounts và
https://help.twilio.com/articles/223135327-Moving-Twilio-phone-numbers-to-another-Twilio-project.

**Trạng thái:** chấp nhận phương án dùng số cũ về mặt chi phí, nhưng **chưa
thực hiện canary**. Số vẫn ở tài khoản chính, webhook và hai salon Live không
đổi; không gửi SMS và không phát sinh cước mới.

### Kiểm chứng thêm khi Huy yêu cầu dùng tạm số cũ

Đọc đúng một hàng `public.platform_settings` trên Supabase **Production**
`fshmobzyjhmtvndobwsy`, chỉ trả về các giá trị boolean, không đọc hoặc in
credential: số cũ **đúng bằng** `twilio_phone_number` hiện cấu hình cho nền
tảng, và cặp Twilio credential có mặt. Source `getTwilioSmsCreds()` ưu tiên
hàng này trước env khi gửi SMS. Do đó đây là **sender đang cấu hình cho đường
Production**, không thể coi là số QA nhàn rỗi chỉ vì nhật ký Twilio gần nhất
hiển thị ngày 31/08. Chưa chứng minh có SMS được gửi hôm nay, nhưng cũng
không thể an toàn chuyển số hay chia sẻ credential này sang Preview.

Quyết định an toàn: **không dùng số này cho QA provider canary**, không chuyển
account, không sửa Production sender/webhook, không gửi SMS. Synthetic tests
vẫn dùng mock/test credentials; chứng cứ provider-delivery thật tiếp tục
`NOT PROVEN` cho đến khi có sender QA tách biệt hoặc một thiết kế canary khác
được rà soát và phê duyệt mà không dùng chung credential Production.

### Một lượt gửi tạm bằng số cũ sau phê duyệt riêng của Huy

Huy sau đó yêu cầu rõ ràng dùng tạm số cũ để test rồi dừng. Phạm vi thực hiện
khác canary QA ứng dụng ở trên: **chỉ một SMS trực tiếp từ Twilio Console**
trên account đang sở hữu số, tới số thử do Huy đã cung cấp; không chuyển số,
không sao chép credential, không đổi webhook, không bật NailIQ outbound và
không tạo lịch hẹn. Nội dung là tin `NailIQ TEST`, một segment, không có link,
booking hoặc khoản thu.

Twilio Console trả `201 Created` lúc **29/09/2026 11:16:07 PDT**, Message SID
được giữ ở Console (hồ sơ này chỉ ghi dạng `SM…ccb3`), trạng thái ban đầu
`queued`. Nhật ký của đúng số gửi sau đó hiển thị **một** dòng outbound mới
lúc **11:16:08 PDT**, một segment, trạng thái **Delivered**. Không bấm gửi
lại. Không in số nhận đầy đủ hoặc token trong hồ sơ.

Đây là bằng chứng **Twilio nhận và báo giao một SMS trực tiếp**, không phải
chứng cứ `sendSmsReminder` của NailIQ, callback ký xác thực, durable delivery
receipt hoặc consent/STOP. Tại thời điểm đọc Console, điện thoại người nhận
chưa tự xác nhận hiển thị; xác nhận này được bổ sung bên dưới.
NailIQ QA/Preview vẫn giữ outbound OFF; P1-01 ứng dụng chưa PASS toàn diện.
Số vẫn cấu hình Production như trước. Theo yêu cầu "rồi không sử dụng nữa",
không dùng số này cho lượt QA tiếp theo; không có thao tác release/chuyển số
vì số vẫn là sender Production.

Huy sau đó xác nhận trực tiếp trong chat: **"đã nhận"**. Vì vậy phép thử
đơn lẻ này có cả trạng thái Twilio `Delivered` lẫn xác nhận của người nhận.
Điều này không thay đổi giới hạn: đường gửi ứng dụng NailIQ, status callback,
durable receipt và STOP/START vẫn chưa được kiểm chứng bằng tin này.

### Đối chiếu receipt sau khi nhận tin — chỉ đọc

Tra đúng Message SID của lượt thử trong `public.sms_delivery_attempts` và
`public.twilio_message_status_receipts` trên cả Supabase Production
`fshmobzyjhmtvndobwsy` lẫn QA `uhpzafoiifupyypkcwln`: **0 hàng khớp ở
cả bốn phép đếm**. Query chỉ trả count, không lấy contact hoặc nội dung tin.
Đây là kết quả phù hợp với việc gửi qua Twilio Console thay vì dispatcher
NailIQ; không phải bằng chứng ứng dụng đã mất một receipt mà nó phải tạo.
Không ghi thủ công `Delivered` vào database, không gọi callback giả và không
gửi lại. Cổng ứng dụng P1-01 vẫn mở.

### Guard callback Preview — chỉ triển khai local, chưa publish

Source hiện tại chọn URL callback tường minh trước, rồi `NEXT_PUBLIC_APP_URL`,
`VERCEL_URL`, sau cùng `nailiq.ca` khi `NODE_ENV=production`. Vercel Preview
cũng chạy `NODE_ENV=production`, nên một URL tường minh hoặc public URL sao
chép từ Production có thể định tuyến receipt sang môi trường sai nếu sau này
bật SMS QA. Đây là **rủi ro source**, chưa có bằng chứng đã xảy ra với salon.

Đã sửa cục bộ `bindSmsAttemptToStatusCallback`: khi `VERCEL_ENV=preview`, chỉ
chấp nhận callback cùng origin với `VERCEL_URL` của deployment; URL tường minh
khác origin hoặc thiếu deployment URL trả `null`, khiến dispatcher dừng trước
provider. Luồng Production giữ nguyên. Vercel mô tả `VERCEL_ENV` là
`production`/`preview`/`development`, còn `VERCEL_URL` là generated deployment
domain; xem https://vercel.com/docs/environment-variables/system-environment-variables.

Kiểm tra cục bộ: 4 suites SMS/callback/consent **43/43 PASS** gồm cả ca
Production fallback; typecheck, lint file chạm và `next build` **PASS** (61/61
static pages). Không gọi provider trong các bước này. Việc publish guard
phải có PR/Preview và bằng chứng riêng; test local không có tác động đến hai
salon Live. Dù guard được publish sau này,
`VERCEL_URL` có thể bị Vercel Deployment Protection chặn callback của Twilio;
chỉ URL đúng origin không chứng minh provider có thể truy cập. Trước canary
phải xác minh system env của đúng deployment và đường callback ký xác thực;
không bật outbound dựa vào test local.
