# Ngày 5 — Receptionist Center

## Kết luận hiện tại: PASS kỹ thuật local; chưa ký nghiệm thu người dùng/phát hành

Thời điểm kiểm tra: 2026-09-23 buổi tối America/Vancouver (2026-09-24 UTC).
Base: `f6bf087b9d6f4354c3742ee270ab6aaf78cc8d9d`, nhánh local
`qa/day5-receptionist-20260924`. Chưa commit/push/PR/deploy.

**Cập nhật mới nhất:** xem mục "Lượt chốt kỹ thuật" cuối báo cáo. Các phần
trước đó giữ lại lịch sử red/green, không phải trạng thái cuối. Đã sửa các lỗi
locale, focus, busy/free và hai race đổi ngày; đã có kiểm thử database và Computer Use.
Lượt cuối: 208 unit tests, 6 UI journeys EN/VI, 9 tenant/role và 6 race/retry PASS.
Chưa có Preview/Production, nghiệm thu người mới thật hoặc kết luận nguyên nhân
cho mọi log stream-abort lịch sử (đã truy đúng request của lần tái hiện cuối).
Có thể chuẩn bị QA ngày 6, không tuyên bố ngày 5/phiên
bản bán đã hoàn tất 100%.

## Phạm vi đúng của ngày 5

Đóng vai tiếp tân mới: xem lịch hôm nay, tạo hẹn, thêm walk-in, đổi trạng thái,
tìm thông tin khách. Kiểm tra EN/VI, desktop/điện thoại/iPad; đối chiếu dữ liệu
đã lưu, quyền và sự rõ ràng của thông báo. Tiêu chí gốc Giai đoạn 2: người mới
tạo hẹn và thêm walk-in, mỗi việc dưới 60 giây, không được hướng dẫn; walk-in
dưới 30 giây là mục tiêu bổ sung. Chưa nghiệm thu bằng người mới thật.
Không đánh đồng thời gian automation với mục tiêu này.

## Đã thực hiện local

- Tạo worktree riêng từ main; không động vào ba tài liệu TurnIQ untracked của người dùng.
- Phát hiện bài `operator-journey.spec.ts` trước đây sử dụng demo cookie, không chứng minh
  đầy đủ quyền receptionist. Đổi bài này sang tài khoản Auth synthetic có membership
  `receptionist`, đăng nhập qua form, không dùng demo cookie; bổ sung cleanup tài khoản.
- Thay đổi trên chỉ là mã kiểm thử; chưa có kết quả chạy journey mới do DB local chưa khởi động.
- Không sửa mã ứng dụng, schema hay cấu hình Production.

## Bằng chứng đã chạy

| Lệnh / thao tác | Kết quả |
| --- | --- |
| `npm ci --offline --ignore-scripts` | PASS, 452 packages, npm báo 0 vulnerabilities trong kết quả cài; không thay thế security audit toàn diện |
| `npm run typecheck` | PASS sau thay đổi bài kiểm thử |
| `npm run check:i18n` | PASS: 0 errors, 13 warnings hiện có; không đồng nghĩa mọi câu chữ đã tốt |
| `node node_modules/vitest/vitest.mjs run src/shared/dashboard/__tests__/walkinActualTime.spec.ts src/shared/dashboard/__tests__/receptionistQueueVipFairness.spec.ts src/shared/lib/__tests__/salonMemberRole.spec.ts src/shared/security/__tests__/salonMemberRolesBoundary.spec.ts` | PASS: 4 files, 25 tests |
| `node node_modules/next/dist/bin/next build qa/waitlist-delivery --webpack` | PASS: build fixture riêng, KHÔNG phải full app build |
| `node node_modules/@playwright/test/cli.js test --config qa/waitlist-delivery/playwright.config.ts` | PASS: 4/4, Chromium và WebKit, EN/VI, không retries |
| `git diff --check` | PASS |

## Computer Use — kiểm tra người dùng thực tế trên fixture

Đích `http://127.0.0.1:3116/` và `/?lang=vi`; dùng component
`OnlineWaitlistPanel` thật với dữ liệu synthetic dựng sẵn, không database.

- Danh sách che số điện thoại, chưa hiện email đầy đủ.
- Bấm tên QA Failed mở đúng thông tin: tên, phone/email synthetic, dịch vụ,
  ngày/giờ, any staff, lúc tham gia, thời gian chờ, loại yêu cầu, lý do và trạng thái hai kênh.
- Escape đóng chi tiết và trả focus về nút tên khách; kiểm tra DOM xác nhận drawer đã unmount.
- Nút đóng trong tiếng Việt cũng trả focus về tên khách.
- Viewport thực đo 390 × 844: không overflow ngang; hai nút sao chép rộng 358, cao 44 CSS px.
- Quan sát screenshot bottom sheet; chưa bấm gọi điện, sao chép, mời lại hoặc tạo lịch.
- Reset viewport và đóng tab thử sau khi kiểm tra.

Không dùng bằng chứng fixture này để kết luận khả năng lưu booking, tenant isolation,
RLS, gửi thông báo hoặc toàn bộ receptionist flow đã PASS.

## Những điểm chưa thân thiện cần xem xét

1. VI còn thuật ngữ `Provider đã nhận`, `Trạng thái Waitlist`, `Vào Waitlist lúc`;
   nên dùng từ thuần Việt nhất quán cho người ít rành công nghệ.
2. Ngày mong muốn dùng chuỗi ISO `2026-09-20`, trong khi ngày tham gia đã địa phương hoá.
3. Chờ nhiều ngày hiển thị `13717 phút`; nên có ngày/giờ dễ đọc, không chỉ tổng phút.
4. EN nhóm hiển thị `2 guests · 1 services`; cần số ít/số nhiều đúng.

Đây là phát hiện UX/copy trên local, không phải bằng chứng lỗi giao dịch.
Bốn điểm đã được sửa local trong lượt cải thiện bên dưới; chưa phát hành.

## Cải thiện giao diện theo góp ý — local-only

Phạm vi được duyệt: sửa bốn điểm trình bày trên, kiểm thử và dùng Computer Use.
Không commit/push/PR/deploy; không database, thông báo hoặc provider.

### Đã triển khai local

- VI: `Đơn vị gửi đã nhận`, `Trạng thái chờ chỗ`, `Vào danh sách chờ lúc`,
  `Lý do vào danh sách chờ`. Trạng thái đơn vị gửi nhận yêu cầu vẫn KHÁC đã giao.
- Ngày mong muốn trong danh sách và drawer được địa phương hoá theo EN/VI.
  Giá trị ngày lịch không bị đổi ngày do timezone thiết bị; ngày sai hiển thị `—`.
- `13717 phút` thành `9 ngày 12 giờ 37 phút`; không làm tròn tăng và không
  sửa thuật toán tính tuổi, ưu tiên hoặc trạng thái hàng chờ.
- EN: `1 guest`, `2 guests`, `1 service`, `2 services` đúng số ít/số nhiều.
- Khi mở rộng kiểm thử, phát hiện Safari không tự focus nút tên khách khi chạm.
  Đã focus trigger trước khi mở Drawer để cả Escape và nút đóng trả focus đúng.
  Sửa tại OnlineWaitlistPanel, không sửa primitive Drawer dùng chung.

### File trong lượt cải thiện

- `src/components/receptionist/OnlineWaitlistPanel.tsx`
- `src/shared/lib/waitlistPresentation.ts`
- `src/shared/lib/__tests__/waitlistPresentation.spec.ts`
- `src/shared/i18n/user/en.ts`
- `src/shared/i18n/user/vi.ts`
- `qa/waitlist-delivery/app/page.tsx`
- `qa/waitlist-delivery/tests/delivery-status.spec.ts`
- Báo cáo này.

Thay đổi `e2e/receptionist-center/operator-journey.spec.ts` thuộc lượt ngày 5 trước,
được giữ nguyên, chưa được xem là journey đã chạy thành công.

### Kiểm chứng thực tế

- Red/green: 12 kiểm thử copy ban đầu tái hiện 9 FAIL trước sửa. Sau thêm các
  biên ngày nhuận/ngày sai/DST/múi giờ/giờ/phút, 30/30 kiểm thử mới PASS.
- `node node_modules/vitest/vitest.mjs run src/shared/lib/__tests__/waitlistPresentation.spec.ts src/shared/dashboard/__tests__/walkinActualTime.spec.ts src/shared/dashboard/__tests__/receptionistQueueVipFairness.spec.ts src/shared/lib/__tests__/salonMemberRole.spec.ts src/shared/security/__tests__/salonMemberRolesBoundary.spec.ts`: 55/55 PASS.
- `node node_modules/vitest/vitest.mjs run src/shared/dashboard/__tests__/waitlistAttention.spec.ts src/shared/noshow/__tests__/waitlistDeliveryGuidance.spec.ts src/shared/noshow/__tests__/waitlistDeliveryTruth.spec.ts src/shared/security/__tests__/waitlistTerminalDeliveryTruthBoundary.spec.ts src/shared/security/__tests__/falseWaitlistAndDetailsBoundary.spec.ts`: 105/105 PASS. Đây là unit/boundary tests, không thay thế tenant E2E trên DB.
- `npm run typecheck`: PASS; chạy tuần tự với các lần build.
- `npm run check:i18n`: PASS, 0 errors, 13 warnings có sẵn ngoài phạm vi.
- `node node_modules/eslint/bin/eslint.js src/components/receptionist/OnlineWaitlistPanel.tsx src/shared/lib/waitlistPresentation.ts src/shared/lib/__tests__/waitlistPresentation.spec.ts src/shared/i18n/user/en.ts src/shared/i18n/user/vi.ts qa/waitlist-delivery/app/page.tsx qa/waitlist-delivery/tests/delivery-status.spec.ts`: PASS.
- `node node_modules/next/dist/bin/next build qa/waitlist-delivery --webpack`: PASS.
- `npm run build`: full app build PASS, kể cả lần chạy lại sau sửa focus Safari.
  Còn cảnh báo Edge Runtime deprecated có sẵn; không phải lỗi build của bản sửa.
- `git diff --check`: PASS; giữ nguyên thay đổi trước đó, không stage/commit.
- `node node_modules/@playwright/test/cli.js test --config qa/waitlist-delivery/playwright.config.ts`: lần đầu không được mở localhost trong sandbox (EPERM); chạy với quyền local server thành công. Lần chạy mở rộng tái hiện 2 FAIL focus trên WebKit, sau sửa chạy lại **4/4 PASS, không retry**. Mọi request ngoài localhost hoặc ngoài GET/HEAD bị chặn.
- Screenshot và kết quả UI: `test-results/waitlist-delivery/results.json`,
  `test-results/waitlist-delivery/artifacts/` (local, không commit).
- Computer Use: VI 390×844 mở QA Failed; ngày và thời gian chờ đúng, không
  overflow ngang, hai nút copy cao 44px/rộng 358px. Đóng bằng nút trả focus về tên.
  EN desktop mở QA Group bằng Enter, xác nhận `2 guests · 1 service`, ngày,
  thời gian chờ; Escape đóng, DOM không còn chi tiết, focus về tên nhóm.
  Không bấm gọi, copy, mời hoặc tạo lịch. Reset viewport và đóng tab sau thử.
- Rà soát Next.js/React: định dạng ngày lịch dùng UTC rõ ràng; không thêm effect,
  state phái sinh, dependency, màu hoặc primitive mới. Không sửa quyền hay request API.

**PASS local cho bốn cải thiện và focus regression. Chưa Preview/Production-verified.**
Không thể dùng kết quả fixture này để đóng toàn bộ ngày 5: DB journey vẫn bị chặn
bởi môi trường bên dưới; chưa xác minh ghi booking thật hay nghiệm thu người dùng mới.

## Trở ngại môi trường

Docker truy cập được, không có container đang chạy trước setup.
Stack mới riêng: `/private/tmp/nailiq-day5-stack`, project id `nailiq-day5-20260924`.
Không sử dụng dữ liệu/secret Production. Mail catcher local, SMS provider không cấu hình.

- Supabase CLI 2.76.8 thất bại khi tải/giải nén PostgreSQL: `no space left on device`.
- Thử CLI 2.117.0 để dùng image hiện có: vẫn thất bại khi tạo volume cùng lỗi dung lượng.
- Docker báo images khoảng 29.75 GB; ổ Mac còn khoảng 530 GiB. Vấn đề là ổ đĩa VM Docker,
  không phải ổ Mac hết chỗ. Không xoá image/volume cũ, không restart hay đổi cấu hình VM.
- Đã hỏi duyệt tăng ổ Docker QA thêm 20 GB; chưa nhận trả lời tại thời điểm viết báo cáo.
- Chưa áp baseline, chưa seed tenant/Auth/booking trong lượt ngày 5 này.

## Danh sách còn lại tại checkpoint trước (xem cập nhật bên dưới)

1. Giải quyết dung lượng Docker sau khi được duyệt; khởi động DB local.
2. Chạy guard không-Production, baseline và schema parity trước khi seed.
3. Chạy journey mới bằng receptionist thật trên 4 cấu hình thiết bị/ngôn ngữ;
   chạy role/tenant/collision/retry liên quan nếu môi trường sẵn sàng.
4. Dùng Computer Use hoàn tất năm việc với dữ liệu synthetic có lưu DB; đọc lại kết quả,
   không gọi provider hoặc gửi email/SMS. Kiểm tra tạo hẹn và walk-in riêng lẻ khi quầy bận.
5. Tái hiện và ưu tiên các vấn đề UX, sửa có kiểm thử khi nằm trong phạm vi được duyệt.
6. Dọn synthetic tenant/account và kiểm tra không còn dữ liệu thử.
7. Nghiệm thu với người mới thật trước khi kết luận đạt mục tiêu usability.

Production không thay đổi; không gửi email/SMS, không thanh toán, không gọi provider.

## Tiếp tục QA có database — 2026-09-24 UTC

### Môi trường và ranh giới

- Dùng lại profile Colima `nailiq-p0-503`, ban đầu đang tắt, còn khoảng 16 GB trống.
  Khởi động với `--activate=false --save-config=false`; Docker context mặc định
  vẫn là `colima`. Không tăng ổ đĩa, xoá image/volume cũ hoặc sửa cấu hình cũ.
- Tạo stack mới `nailiq-day5-20260924` trong `/private/tmp/nailiq-day5-stack`.
  Supabase CLI 2.117.0; API `127.0.0.1:54321`, PostgreSQL `127.0.0.1:54322`.
- `node qa/day5/run-local.mjs baseline`: PASS guard không-Production; chỉ áp
  khi public schema trống. Folded baseline + 269 forward migrations + reference
  data; schema parity/ACL/RLS đối chiếu theo repo PASS. Không phải Production evidence.
- Runner từ chối dotenv, giữ local keys trong memory, không kế thừa provider credentials.
  SMS/email/call OFF; payment workers, card dispatch, Square ingestion OFF;
  demo OTP và demo slug bypass OFF. Auth synthetic được xác nhận bằng local admin API,
  không gửi email. Không đọc/copy Production secrets.

### Bằng chứng mới

- `node qa/day5/run-local.mjs build`: full app build PASS trước và sau sửa KPI.
- `node qa/day5/run-local.mjs test receptionist-center/operator-journey.spec.ts`:
  **6/6 PASS**, 49.4 giây, không retry, bản sau sửa. Desktop Chromium EN/VI,
  iPhone 14 WebKit EN/VI, iPad WebKit EN/VI. Đăng nhập qua form bằng membership
  receptionist, không demo cookie; xem hôm nay, tạo hẹn, tìm khách, thêm bốn walk-in,
  bắt đầu phục vụ và đối chiếu trạng thái/source/contact trong DB.
- Thêm regression UI: hẹn confirmed cách 45 phút không được tính vào KPI 30 phút;
  so số hiển thị với truy vấn DB trong cửa sổ 30 phút, trên cả sáu cấu hình.
- `node qa/day5/run-local.mjs test p0-tenant-auth.spec.ts --project=desktop-en --reporter=list --output=test-results/day5-tenant`:
  **9/9 PASS**, 10.4 giây. Năm vai trò, đọc/ghi khác salon, settings RPC,
  revoked session, mất membership khi form đang mở, admin hạ xuống nail_tech EN/VI.
- `node node_modules/vitest/vitest.mjs run src/shared/dashboard/__tests__/receptionistKpiWindow.spec.ts src/shared/lib/__tests__/waitlistPresentation.spec.ts`:
  **37/37 PASS**. Test KPI tái hiện 2 FAIL trước sửa, sau sửa 7/7 PASS.
  Lần import đầu cần mock `server-only` trong unit harness; không sửa boundary ứng dụng.
- `node node_modules/tsx/dist/cli.mjs src/shared/dashboard/__tests__/basicModeCockpit.test.ts`:
  **26/26 PASS**. Lần đầu tsx bị sandbox chặn IPC; chạy lại với quyền localhost PASS.
- Typecheck, lint các file được sửa và `git diff --check`: PASS tại checkpoint này.
- `node qa/day5/run-local.mjs test receptionist-center/operator-journey.spec.ts --project=desktop-en --reporter=list --output=test-results/day5-cleanup-check`:
  **1/1 PASS** để kiểm tra teardown mở rộng cho hồ sơ khách global.
- `node qa/day5/run-local.mjs test walkin-response-loss.spec.ts conflict-prevention.spec.ts --project=desktop-en --project=mobile-en --reporter=list --output=test-results/day5-race-retry`:
  **6/6 PASS**, 16.3 giây, không retry. Xung đột slot không xếp chồng; mất response
  sau commit rồi thử lại chỉ có một walk-in; hết thợ giữa kiểm tra và submit vẫn
  giữ đúng khách ở queue. Hai spec được đổi từ demo cookie sang real receptionist Auth.
- Tổng acceptance mới: **21/21** (6 journey + 9 tenant + 6 race/retry), không tính
  lặp lại desktop cleanup là một scenario mới. Typecheck/lint/diff-check chạy lại
  sau thay đổi harness cuối: PASS. `node qa/day5/run-local.mjs parity` cuối: PASS.

### Computer Use — không còn chỉ là fixture không DB

- Tài khoản synthetic, quyền receptionist thật, đăng nhập vào app localhost qua form.
- Đọc lịch hôm nay; thêm khách Mai QA + phone synthetic + Polish Change.
  UI xác nhận thành công, hàng chờ tăng một; mở contact thấy đúng số điện thoại,
  cảnh báo chưa có đồng ý SMS; đóng trả focus về tên khách.
- Xếp chỗ vào Riley 04:30 bằng grid; thấy thông báo đã xếp và nút Hoàn tác.
  DB xác nhận duy nhất một walk-in, status `confirmed`, đúng thợ và giờ.
- Tạo hẹn Lan QA, Quick Trim, Sam 05:00; SMS/email disabled và hiện rõ
  "Khách sẽ không được báo". Booking xuất hiện trên lịch, đúng dịch vụ/thợ.
- Bấm "Bắt đầu phục vụ"; DB xác nhận `appointment`, `in_progress`.
- Mở Khách hàng, tìm bằng bốn số cuối; danh sách từ hai xuống đúng một khách Lan QA.
- Những thao tác này kiểm tra chức năng trên desktop tiếng Việt, KHÔNG chứng minh
  một người mới thật hoàn thành trong 30/60 giây. Đã đóng tab và xoá tài khoản/tenant thử.

### Lỗi mới đã sửa local

**KPI "Sắp tới (30p)" tính 60 phút.** Computer Use lúc 04:12 thấy hai lịch
04:30 và 05:00 đều bị đếm. Gốc: `COMING_UP_WINDOW_MINUTES = 60`, trong khi
nhãn EN/VI và config Basic Mode là 30. Đổi loader sang dùng config chung 30 phút;
export hàm tính thuần để test. Không thay đổi booking, availability, quyền hoặc schema.
File thêm/sửa: `loadReceptionistCenterData.ts`, `receptionistKpiWindow.spec.ts`,
regression trong `operator-journey.spec.ts`.

### Phát hiện cần xử lý/kiểm chứng tiếp, không che bằng PASS automation

1. P2 ngôn ngữ: tiếng Việt vẫn có `min`, `m`, status accessibility `Available/Busy`,
   và ngày trong drawer `Thu, Sep 24`. Chưa sửa trong đợt KPI này.
2. P2 accessibility: form hẹn mới có nhãn nhìn thấy nhưng AX/DOM báo nhiều textbox,
   combobox không có accessible name; focus còn tại nút mở trong snapshot.
   Cần regression keyboard/screen-reader và sửa liên kết label/focus.
3. Runtime log có `The destination stream closed early`, digest `1483451839`.
   Mã React tạo thông báo này khi stream đích đóng; xuất hiện khi harness đổi trang
   nhanh. Chưa cô lập đủ để kết luận chỉ là test noise; không tuyên bố "không có lỗi log".
4. Gợi ý trong form từng ghi Casey rảnh trong khi badge grid ghi Busy; fixture có
   một booking `in_progress` ở tương lai. Chưa suy ra lỗi Production; cần fixture
   giờ thực nhất quán để phân biệt dữ liệu thử bất thường và bug gợi ý.

### Dọn dữ liệu

- Sau journey/tenant/Computer Use: salon=0, auth user=0, booking=0.
- Phát hiện teardown salon không xoá `client_profiles` global: còn 14 hồ sơ,
  cả 14 có marker `Te2eGuest`. Đã dọn bằng transaction chỉ trên stack QA riêng,
  guard từ chối nếu còn salon/user/booking hoặc có profile ngoài marker; còn 0.
- Thêm `qa/day5/teardown.ts` để các lần chạy sau tự dọn đúng marker này sau khi
  xác nhận không còn salon. Không đổi cleanup hoặc dữ liệu Production.
- Đọc lại sau toàn bộ race/retry: salon=0, auth user=0, booking=0, client profile=0.
  Đã dừng đúng Supabase project với backup=true, không dùng `--no-backup` hay `--all`;
  giữ schema/volume để tái dùng. Server ứng dụng và tab Computer Use đã đóng.

### Chưa nghiệm thu / xuất bản

- Chưa có Preview/Production verification cho các thay đổi local của ngày 5.
- Chưa nghiệm thu thao tác với người mới thật; chưa coi tổng số giây automation là usability.
- Race/retry đã PASS như trên; còn các phát hiện UI/ngôn ngữ và nghiệm thu người dùng
  trước khi đóng ngày 5. Không mở rộng thành tính năng hoặc thay đổi chính sách mới.
- Không commit, push, tạo PR, merge, deploy, gọi provider hay gửi thông báo thật.

### File bổ sung trong lượt tiếp tục

- `qa/day5/run-local.mjs`, `qa/day5/playwright.config.ts`, `qa/day5/manual-fixture.ts`,
  `qa/day5/teardown.ts`: runner local-only, real Auth, kill switches, teardown.
- `e2e/receptionist-center/realReceptionist.ts`, `walkin-response-loss.spec.ts`,
  `conflict-prevention.spec.ts`, `operator-journey.spec.ts`: tests quyền receptionist thật.
- `src/shared/dashboard/loadReceptionistCenterData.ts` và
  `src/shared/dashboard/__tests__/receptionistKpiWindow.spec.ts`: sửa/count regression 30 phút.
- Báo cáo này. Giữ toàn bộ file cải thiện Waitlist local của lượt trước, không stage.

Rollback local: chỉ đảo hunk KPI/config import/export và test mới tương ứng nếu bỏ
hotfix; không rollback schema Production vì không có mutation Production. Không reset
toàn worktree; các thay đổi Waitlist chưa commit vẫn cần được giữ nguyên.

## Lượt chốt kỹ thuật — 2026-09-24 UTC

### Đã sửa và kiểm chứng local

1. **Busy/free sai qua hai lớp:** availability query bỏ sót `in_progress` ngoài
   horizon bốn giờ; sau đó bộ tính khoảng trống lại coi thời gian dự kiến tương lai
   là rảnh hiện tại. Query giữ trạng thái đang phục vụ; projection không nhận
   khách trước ETA authoritative. ETA thiếu/cũ phải giữ bận, không đưa vào nhận ngay.
   UI hiện "Đang bận — chưa xác định giờ rảnh", không "chờ 0 phút".
2. **Locale:** trạng thái thợ, accessibility name, workload, ngày chi tiết lịch,
   thời lượng hàng chờ và nút dịch vụ EN/VI. Không đổi múi giờ salon hoặc dữ liệu lịch.
3. **Form hẹn:** label liên kết đúng bảy field; giữ Tab/Shift+Tab trong dialog,
   Escape đóng, trả focus về nút mở (cả Safari). Khóa cuộn nền khi mở.
4. **Tìm khách cũ:** không đóng kết quả sau 150 ms khi focus vẫn nằm trong vùng
   tên/kết quả; chọn bằng Enter và chuyển focus sang email. Mũi tên lên/xuống
   hỗ trợ Safari bỏ qua button khi Tab theo thiết lập mặc định.
5. **Chi tiết lịch:** focus container, vòng Tab, Escape, trả về lịch vừa chọn.
   Hook nhường focus cho modal con thay vì giành bàn phím từ modal đó.
6. **Race đổi ngày:** background reload hôm nay hoàn tất muộn từng ghi đè ngày
   mai sau khi người dùng đã mở/đóng drawer. Đã kiểm tra requested/response/current
   day bên trong functional state update; snapshot ngày cũ không thay màn hình mới.
   Ba regression tests gồm response trì hoãn, fresh cùng ngày và ngày sai.
7. **URL mất ngày sau refresh:** truyền `window.history.state` chứa `__NA`
   khiến Next bỏ qua cập nhật canonical URL. Dùng `replaceState(null, ...)`
   theo tài liệu đi kèm phiên bản Next, để Router tự bảo toàn internal state.
   Áp dụng cả xóa query recovery. Journey kiểm tra URL sau đổi ngày và sau
   mutation đổi trạng thái lịch; không bỏ assertion để che lỗi.

### Red/green, không che các lần FAIL

- Unit availability: 9/10 FAIL trước sửa → 10/10 PASS.
- Projection: năm hồi quy mới FAIL trước sửa → 14/14 PASS toàn file sau sửa.
- Desktop DB UI bắt được projection còn báo free sau lần sửa query đầu tiên;
  đã sửa projection rồi chạy lại PASS.
- Ma trận đầu: desktop EN/VI PASS, bốn WebKit FAIL ở Tab chọn khách cũ.
  Đã thêm arrow navigation rồi chạy đủ sáu profile PASS, không retry.
- Một lượt thử `networkidle` bị ngắt vì app có kết nối dài; đổi gate về
  `load` và các UI assertions. Không tính lượt bị ngắt là PASS.
- Khi siết thêm kiểm tra JavaScript, sáu ca phát hiện chính init script của test
  đọc localStorage trên trang opaque `about:blank`. Đã giới hạn script locale
  chỉ chạy ở app origin; không lọc/bỏ qua lỗi trong ứng dụng để qua assertion.
- WebKit còn báo access-control khi pending request bị chuyển sang trang trắng.
  Đổi journey sang bấm "Ngày mai" như người dùng; fallback qua trang cùng origin
  nếu ngày kế là ngày đóng cửa. Mobile diagnostic PASS với assertions không
  có pageerror/HTTP5xx; không tắt bảo mật Safari hoặc chặn log ứng dụng.
- Lượt siết tiếp phát hiện background reload kéo ngày mai về hôm nay (screenshot
  Today được chọn sau khi future card biến mất), và một hard navigation dư ngay
  sau đăng nhập vẫn hủy các request khởi tạo dashboard. Sửa app date guard; seed
  trước đăng nhập và chờ trang đích hydrate, không hard reload lại landing page.
  Các lượt 4/6 hoặc 2/6 này là FAIL, không dùng kết quả PASS cũ thay thế lượt cuối.
- Sau date snapshot guard, UI giữ ngày mai nhưng URL bị refresh trả về `/center`.
  Đã sửa canonical URL như trên. Một lượt tiếp gặp hai board trong lúc chuyển
  trang SPA; test chờ destination còn đúng một board trước strict locator.
  Lượt cuối đủ **6/6 PASS, không retry**, giữ kiểm tra pageerror và HTTP 5xx.

### Lệnh và kết quả

- `node qa/day5/run-local.mjs build`: full Next build PASS.
- `npm run typecheck`: PASS, chạy sau build, không đồng thời tạo `.next/types`.
- `node --import tsx scripts/check-i18n.ts`: 0 errors, 13 warnings có sẵn.
- ESLint các TS/TSX sửa trong receptionist, shared availability, locale và tests:
  0 errors; hai warning cũ ở BookingBlock (biến chưa dùng) không bị che.
- `git diff --check`: PASS.
- Vitest targeted: **208/208**, 17 files. Các file:
  `receptionistLocale`, `QueueEntryCard`, `salonTimeDst`,
  `availabilityEngineSequence`, `walkinGapSafety`, `receptionistKpiWindow`, `receptionistDaySnapshot`,
  `waitlistPresentation`, `walkinActualTime`, `receptionistQueueVipFairness`,
  `salonMemberRole`, `salonMemberRolesBoundary`, `waitlistAttention`,
  `waitlistDeliveryGuidance`, `waitlistDeliveryTruth`,
  `waitlistTerminalDeliveryTruthBoundary`, `falseWaitlistAndDetailsBoundary`.
- `node qa/day5/run-local.mjs test receptionist-center/operator-journey.spec.ts`:
  **6/6 PASS**, desktop Chromium/iPhone 14 WebKit/iPad WebKit × EN/VI.
  Lượt xác minh đầu chạy thêm `--max-failures=1`, vẫn đủ sáu ca, tổng 55.5 giây;
  chạy lại lần cuối không diagnostic: **6/6 PASS, 51.9 giây**, không retries.
  không pageerror/HTTP 5xx trong hành trình. Server stream warning báo riêng bên dưới.
- `node qa/day5/run-local.mjs test p0-tenant-auth.spec.ts --project=desktop-en --reporter=list --output=test-results/day5-tenant`:
  **9/9 PASS**. Real Auth owner/admin/senior/receptionist/nail_tech; cross-tenant,
  revoked session, membership removal và form đã mở sau demotion EN/VI.
  Chạy lại trên ứng viên cuối: 9/9, 10.7 giây.
- `node qa/day5/run-local.mjs test walkin-response-loss.spec.ts conflict-prevention.spec.ts --project=desktop-en --project=mobile-en --reporter=list --output=test-results/day5-race-retry`:
  **6/6 PASS**; không duplicate khi response mất; assignment conflict giữ khách
  trong hàng chờ, không làm mất khách đã tạo.
  Chạy lại trên ứng viên cuối: 6/6, 16.9 giây.
- `node qa/day5/run-local.mjs parity`: schema contract, service-only ACL và core
  RLS PASS trên QA local. Không phải Supabase Production advisors.
- `node --test qa/day5/stream-abort-reproduction.cjs`: **2/2 PASS** diagnostic
  độc lập, không HTTP/DB/provider.
- `node --test qa/day5/stream-abort-reproduction.cjs qa/day5/stream-request-correlation.test.cjs`:
  **5/5 PASS**, gồm từ chối môi trường không xác minh, HTTP loopback abort và
  bỏ extra asset diagnostic nhưng vẫn giữ log lỗi gốc.
  Không database/provider; các ca diagnostic không cộng vào acceptance nghiệp vụ.

Tổng bộ acceptance database: **21/21 ca duy nhất**; các lần chạy lại không được
cộng thành chức năng mới. Unit 208 và diagnostic 2 được báo riêng.

### Computer Use cuối

Đăng nhập Auth receptionist synthetic qua form ở `127.0.0.1:3117`:

- Chi tiết `RC Display Appt`: focus vào dialog; Shift+Tab tới hành động cuối;
  Tab quay về Đóng; Escape trả về chính booking đã mở. Không bấm Hủy.
- Ngày hiển thị tiếng Việt, giữ giờ salon.
- Walk-in chọn Casey: timeline "Đang bận", thẻ đề xuất "Đang bận — chưa xác
  định giờ rảnh", có nút chọn thợ khác. Không submit walk-in trong lượt cuối này.
- Bản sửa đơn vị phút ở service chips được phát hiện từ lần nhìn UI này và
  kiểm chứng bổ sung qua ma trận EN/VI. Các hành vi lưu lịch/start/walk-in/retry
  có DB proof từ bộ 21 ca, không suy diễn chỉ từ screenshot.
- Xóa đúng fixture synthetic vừa tạo; đóng tab QA. Không dùng tài khoản salon thật.
- Kiểm tra Computer Use bổ sung trên bản cuối: chọn Ngày mai → bấm Làm mới →
  reload toàn trang. URL giữ `date=2026-09-25`, lịch giữ ngày 25/09 và sau hydration
  tab Ngày mai vẫn được chọn. Nút dịch vụ hiển thị "45 phút". Không tạo lịch trong
  lần kiểm tra bổ sung; đã dọn fixture và đóng tab QA.

### Log runtime còn phải phân biệt

`The destination stream closed early.` (digest `1483451839`) vẫn xuất hiện
trong các lượt browser automation, kể cả lượt chức năng PASS. Diagnostic dùng
React 19.2.8 chứng minh đóng destination giữa render gây đúng thông báo;
render hoàn tất bình thường không có lỗi. Đây **không** phải bằng chứng rằng
mọi occurrence trong NailIQ đều là teardown vô hại. Một receipt QA đọc được
gắn route pattern `/register`; không có Production evidence trong lượt này.
Không sửa/suppress `instrumentation.ts`, không tắt báo lỗi để làm test xanh.
Manual session cuối không ghi nhận thông báo stream-abort; có hai log refresh
token không còn tồn tại từ phiên synthetic đã bị dọn trước đó, đăng nhập mới
thành công. Không kết luận đây là lỗi đăng nhập tài khoản thật.

**Đã xác minh thêm bằng request correlation QA thật:** chạy cùng journey
mobile-en qua `qa/day5/stream-diagnostic.config.ts`, PASS 1/1 (10.7 giây).
Preload chỉ ở QA, không thay app; log gốc vẫn được chuyển nguyên trạng.

- Request `5131-25`, `POST /register`: response đóng lúc
  `2026-09-24T05:23:23.227Z`, `writableFinished=false`; ngay sau đó cùng request ID
  ghi stream error digest `1483451839` lúc `.228Z`. Tiếp theo `GET /register/setup`
  hoàn tất status 307. Source auth dùng `window.location.assign` sau sign-in.
- Ở cuối journey, request `5131-177` GET center và `5131-179` GET dashboard cũng
  có close chưa finish và stream error cùng ID. Đây là bằng chứng response bị
  ngắt trong lượt browser/teardown, không phải suy từ việc test xanh.
- Không log headers/body/cookie/query/email/slug trong diagnostic. Không dùng
  kết quả này để bỏ qua mọi lỗi có cùng digest trên Production hoặc lịch sử.
- Lượt diagnostic thứ hai PASS 1/1, 11.3 giây: POST register hoàn tất bình
  thường, không stream error; hai lỗi cuối journey đều ghép được cùng ID với
  response close chưa finish (`5664-179`, `5664-177`). Vì thế auth warning phụ
  thuộc thời điểm chuyển trang, không xảy ra ở mọi lần đăng nhập.
- Bằng chứng kiểm thử nghiệp vụ vẫn độc lập với diagnostic; không tắt cảnh báo
  để đạt PASS. Không có lỗi runtime chưa giải thích trong UI assertions của sáu
  journey cuối; historical server logs là phạm vi theo dõi riêng.

### File thay đổi bổ sung

- Receptionist: DeskBookingForm, BookingDetailDrawer, BookingBlock, VerticalDayView,
  WalkinAddForm, QueueEntryCard, WalkinQueueSidebar, ReceptionistCenter,
  StaffTimelineGrid và locale test mới.
- Shared UI: StaffAvatar, `useOverlayFocus.ts` mới (hành vi cho overlay hiện có,
  không tạo UI primitive khác; Modal/Drawer shared không đổi).
- Shared data: availabilityEngine, walkinGapSafety và regression tests;
  salonTime, EN/VI dictionaries.
- QA: operator journey được mở rộng, stream diagnostic; báo cáo ngày 5 và
  `masterplan-day-6-admin-handoff-2026-09-24.md`.

### Ranh giới đóng và bước kế

- **PASS local functional gate** cho năm công việc receptionist, ngôn ngữ,
  focus, data, role và race/retry trong phạm vi đã chạy.
- **Chưa đóng toàn bộ nghiệm thu ngày 5:** V1-21 (người mới thật thao tác không
  hướng dẫn theo tiêu chí gốc) chưa có; Preview chưa phát hành. Runtime warning
  đã có request-level attribution trong local QA; không kết luận cho lịch sử/Production.
- Nested deposit modal đã review tĩnh, chưa runtime-test bằng provider-free
  fixture. Week/month focus restoration không nằm trong sáu day-view journeys.
- Ngày 6 đã có bàn giao năm công việc Admin/iPhone; có thể tiếp tục QA local
  mà không đợi Production. Không đánh dấu V1-24 physical iPhone là PASS.
- Chưa commit, push, PR, merge, deploy; không migration mới; không provider,
  SMS/email/call/payment hoặc thay đổi Production/salon Live.
- Cleanup cuối đã xác nhận 0 salon, 0 Auth user, 0 booking, 0 client profile
  trong stack QA local; log kỹ thuật synthetic giữ để đối chiếu. Đã đóng tab QA.
  Đã dừng riêng Supabase `nailiq-day5-20260924` và Colima `nailiq-p0-503`, giữ backup.
  Artifact JSON/screenshot nằm dưới `test-results/` được Git ignore; diagnostic
  có thư mục riêng, không ghi đè ma trận sáu ca.

Rollback: đảo đúng các hunk của hotfix và test liên quan sau khi review, không
reset toàn worktree. Không có migration cần rollback. Các thay đổi chưa phát
hành không ảnh hưởng salon Live; không tự triển khai chỉ vì test local PASS.
