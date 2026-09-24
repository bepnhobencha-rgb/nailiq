# Ngày 5–6 — xác minh Preview PR #1424

Thời điểm: 24/09/2026. Checkpoint ban đầu 09:16 UTC; bổ sung bên dưới sau CI và hosted login. Chỉ QA/Preview, không phát hành.

## Bản đã triển khai

- PR: https://github.com/bepnhobencha-rgb/nailiq/pull/1424 — giữ Draft.
- Branch: `qa/day5-receptionist-20260924`.
- SHA: `8e220721124b67d350bb66d35fa1a881404273f8`.
- Vercel Preview: `dpl_ARd4efkWKbKHnRECe9BfZyv288ga` — READY.
- URL: https://nailiq-mrihr7f66-bepnhobencha-2588s-projects.vercel.app
- Alias: https://nailiq-git-qa-day5-reception-b8704e-bepnhobencha-2588s-projects.vercel.app
- Supabase QA: `uhpzafoiifupyypkcwln`.

Huy đã duyệt sao chép kín QA riêng nhánh và manual Preview deploy. Ghi chú
“chờ phê duyệt cấu hình Preview” trong báo cáo trước commit đã được giải quyết.

## An toàn cấu hình — PASS

- 60 biến chỉ có target Preview và đúng gitBranch. 32 khóa/kết nối ngoài để
  trống; SMS/email/call, payment workers/dispatch, card-save dispatch và các
  đường webhook/provider liên quan đã khóa theo cấu hình batch.
- Dùng lại anon/service-role key QA hiện có; xác minh JWT role/ref trong bộ
  nhớ. HEAD read-only QA REST trả 200. Không tạo key hoặc đổi Auth/SMTP.
- So sánh hash metadata các biến ngoài nhánh trước/sau: không đổi.
- Non-sensitive env được đọc lại và so sánh giá trị; sensitive env xác minh
  scope/type và API chấp nhận, không đọc hoặc in giá trị secret.
- APP_URL/SITE_URL trỏ alias Preview xác minh được, không fallback Production.
- Có một build khởi tạo dùng URL `.invalid` an toàn trước khi biết alias;
  bản đó không được dùng làm bằng chứng nghiệm thu. Bản cuối ở trên đã build
  lại với URL Preview thật.
- Tự deploy Git của nhánh vẫn khóa; không đổi deployment protection.
- Production deployment giữ `dpl_FX3WJBMueRCword7mwJyyhafPNPc`.

## Xác minh trên hosted Preview

- `vercel inspect <Preview> --wait`: READY, target Preview, đúng SHA.
- `vercel curl /api/health --deployment <Preview>`: 200, status `ok`, đúng SHA.
- `vercel curl /api/ready --deployment <Preview>`: 200, status `ready`;
  `database_schema` và `cron_authorization` đều `ok`. Readiness dùng fixed
  nonexistent IDs; không gửi cron hoặc tạo booking.
- Computer Use, tab mới trên Preview: trang login render; chuyển EN → VI;
  bấm liên kết đăng ký; trang register render, vẫn cùng Preview; chuyển VI → EN.
- Ở smoke ban đầu không nhập thông tin tài khoản, không bấm OAuth, không gửi form đăng ký,
  recovery, booking hoặc thông báo.
- Ghi nhận nhỏ chưa sửa trong phạm vi này: tab title login vẫn tiếng Việt khi
  nội dung đang EN; register title song ngữ và một text AX vẫn VI sau chuyển EN.
  Không tuyên bố bản địa hóa hoàn hảo từ smoke này.

## CI tại checkpoint ban đầu (được thay thế bởi kết quả bên dưới)

- PASS: Build/Type Check, Security Audit, i18n, Visual Regression, Smoke,
  receptionist desktop/mobile, tenant roles/session revocation,
  SuperAdmin recovery và các fixture browser booking/auth/waitlist.
- Còn chạy: non-RC E2E và settings recovery real-auth. Chưa tính PASS.
- MQA-0148 workflow thủ công SKIPPED, không tính đã kiểm chứng.

## Giới hạn / bước tiếp theo

- Hosted smoke chưa thay thế kiểm thử đăng nhập đầy đủ hai vai trò trên Preview.
- Các matrix Ngày 5–6 local và CI giữ bằng chứng riêng, không gọi là Production
  hoặc pilot proof. Nghiệm thu người mới/iPhone vật lý vẫn mở.
- Chưa merge, chưa deploy Production, không migration, không gọi provider,
  không gửi email/SMS/call và không thay đổi salon Live.
- Báo cáo này bổ sung local sau commit, chưa commit/push.
- Tiếp theo: chốt hai CI còn chạy; hosted multi-role QA; review trước xin
  phê duyệt phát hành. Không gọi Ngày 5–6 hoặc Master Plan đạt 100%.

## Bổ sung — hosted login BLOCKED, CI FAILED

### Hosted Preview / bảo vệ truy cập

- Tạo đúng hai salon synthetic QA và hai user Owner/Receptionist đã xác nhận
  bằng Admin Auth API (không gửi email), cùng staff/service/booking giả.
  Fixture khóa chính xác QA ref, branch, URL và outbound kill switches.
- Computer Use thử Owner trên immutable Preview và branch alias: đều báo
  `We could not confirm whether your request completed`. Draft được giữ lại.
  Hydration `true`; không bấm OAuth, recovery hoặc tạo tài khoản từ UI.
- Đọc QA Auth: cả hai user chưa có `last_sign_in_at`. Chưa vào được Dashboard
  Owner; Receptionist chưa được thử đăng nhập. Không tính multi-role UI PASS.
- `vercel curl /login --deployment <immutable> -- --request POST --data ''`:
  HTTP 403; không mang credential/action/PII. GET health/readiness vẫn 200.
- `vercel firewall rules list --json`: live rule
  `rule_card_receipt_release_fence_stale_deployment_writers_20260911_poPsrq`
  deny các method ngoài GET/HEAD/OPTIONS trên host không nằm trong danh sách.
  Cả immutable Preview và alias mới đều chưa nằm trong danh sách đó. Điều kiện
  này khớp trực tiếp POST đang lỗi; không quy lỗi cho mật khẩu/Supabase.
- Không sửa hoặc tắt WAF, không tạo bypass rộng, không đổi domain cũ để né rule.
  Phương án cần duyệt: bổ sung đúng alias QA đã xác minh vào nhóm điều kiện
  chặn writer, giữ nguyên toàn bộ host cũ, action deny và nhóm bảo vệ payment
  reconciliation. Không thêm vào nhóm payment-reconciliation. Publish vẫn là
  thay đổi bảo vệ của project, không tự suy ra từ quyền deploy Preview.
- Đã đóng tab QA rồi cleanup. Kết quả fixture: `cleanup=PASS`,
  `salonsRemaining=0`, `accountsRemoved=2`, `onlyThisFixtureTouched=true`.
  Dữ liệu thử/account đã xóa khỏi QA; không thể phục hồi bằng UI thông thường,
  nhưng có thể dựng lại bằng fixture synthetic. Không xóa dữ liệu thật.

### CI và sửa test harness local

- Run `35978580070`: FAILED; shard settings recovery có **188 passed, 8 failed**.
  Tám ca lỗi thuộc `e2e/loyalty-widget-recovery.spec.ts`; aggregate receptionist
  gate đỏ do shard này, không phải desktop/mobile receptionist journey mới lỗi.
- Test cũ gắn lỗi vào request số 1, giữ request số 2, rồi tự trả thành công từ
  số 3. Widget nay đọc lại theo refreshToken của Dashboard; do đó lượt tải nền
  có thể lấy nhầm vai trò retry/thành công. VI cũng vẫn đòi empty-state tiếng Anh.
- Chỉ sửa harness: mô phỏng ba giai đoạn outage/hold/recovery cho mọi lượt đọc
  của action mục tiêu, giải phóng toàn bộ pending reads khi thử lỗi, dùng baseURL
  thật của runner và kỳ vọng EN/VI đúng. Không bỏ kiểm error, aria-busy, nút retry,
  touch target, che phủ, navigation/unmount hoặc phục hồi bằng server thật.
- Thêm config local tái sử dụng guard loopback + real Auth + providers OFF.
  Không sửa app/server action/schema để làm test xanh.
- `node qa/day5/run-local.mjs test --config qa/day6/loyalty-recovery.config.ts`:
  **10/10 PASS**, 21.7 giây, Chromium/WebKit, retries=0.
- Cùng lệnh với `--repeat-each=2`: **20/20 PASS**, 39.5 giây, retries=0.
  Đây là lặp lại 10 kịch bản, không phải 20 chức năng mới. Sau teardown,
  SELECT count trên đúng QA local: salons/users/bookings/client_profiles đều 0.
- `npm run typecheck`, ESLint hai file test/config, `git diff --check`: PASS.
- Không build lại app: chỉ đổi E2E/config/tài liệu; dùng production build đã có.
  Chưa chạy lại CI với harness mới vì chưa commit/push batch này.
- Server vẫn có `The destination stream closed early` quanh navigation;
  lượt lặp còn ghi `membership lookup unavailable not_found` quanh teardown.
  Ghi nhận riêng, không xóa/lọc hoặc suy ra toàn bộ lỗi runtime đã hết.

### Kết luận cập nhật

**Chưa đóng ngày 6.** Local focused recovery PASS; hosted role QA BLOCKED;
CI published SHA còn FAILED. PR #1424 giữ Draft. Không merge/deploy Production,
không migration, không gọi provider hoặc gửi thông báo. Phần bổ sung này và
hai file test/config chưa commit/push.

## Batch xuất bản được duyệt — 24/09, 09:40 UTC

- Huy đã đồng ý cập nhật test/report vào PR #1424 và chuẩn bị ngoại lệ QA.
  Các câu “chưa commit/push” ở trên mô tả checkpoint trước phê duyệt này.
- Đã tạo **một draft change** của WAF, chưa publish: chỉ thêm alias
  `nailiq-git-qa-day5-reception-b8704e-bepnhobencha-2588s-projects.vercel.app`
  vào host list của nhóm chặn writer trong rule đã nêu.
- Script đọc lại và assert đầy đủ: điều kiện khác, action deny, active,
  nhóm payment reconciliation và hai rule SDK còn lại không đổi. Không có
  draft khác trước thao tác; diff sau thao tác đúng một `rules.update`.
- Firewall live chưa thay đổi. Theo hướng dẫn Vercel Firewall, người dùng
  thực hiện Publish sau khi xem diff; agent không tự kích hoạt.
- Cần CI của commit mới xác nhận lại; không lấy kết quả local thay cho CI.
  Preview hiện tại vẫn phục vụ SHA `8e220721`; batch này chỉ test/config/docs,
  chưa đổi application runtime. PR tiếp tục Draft, không merge/deploy Production.

## CI hoàn tất — 24/09, sau 10:04 UTC

- Commit kiểm chứng: `f8526fcb01ac6fdd5befcd2a74e4389ea7f43169`.
  PR #1424 vẫn OPEN/Draft. CI `35982753920` và E2E `35982753932`
  đều kết thúc SUCCESS; 20 checks SUCCESS, 2 SKIPPED (MQA-0148, AI Triage).
- Unit: 851 files PASS / 6 skipped; 6658 tests PASS / 65 skipped.
- Settings recovery: **196 passed**, gồm đủ 10 ca Loyalty EN/VI trên
  Chromium/mobile; không ghi nhận flaky trong nhóm này.
- Receptionist desktop: 109 passed, 4 skipped; mobile: 103 passed, 10 skipped.
  Tenant/role/session revocation: 18 passed; SuperAdmin HTTPS: 54 passed.
  Smoke: 8 passed; visual: 16 passed.
- Non-RC chính: **175 passed, 4 flaky, 2 skipped**. Bốn ca chỉ qua retry #1:
  `booking-errors.spec.ts` idor-8, input-12, input-13 và
  `booking-validation.spec.ts` bv-2. Lỗi ban đầu là không thấy phone gate trong
  5 giây hoặc không thấy marker hydration trong 15 giây. Chưa xác định nguyên
  nhân gốc; không gọi đây là tenant leak, cũng không mặc định lỗi môi trường.
- Các nhóm bổ sung non-RC đều PASS: Guided Setup mobile 6; Reports WebKit 1;
  Superadmin authority WebKit 6; Booking capability WebKit 7; registration
  WebKit 3; booking diagnostics WebKit 10; group placeholders WebKit 18.
- Lệnh xác minh: `gh pr view 1424 --json headRefOid,isDraft,state,statusCheckRollup`,
  `gh run view 35982753932 --log`, và đọc riêng job `107578452905` để đối chiếu
  retry. Không tăng timeout, bỏ assertion hoặc rerun workflow để che lỗi.
- `vercel firewall overview --json`: draft vẫn tồn tại; active rule chưa cho
  phép alias QA. Do đó hosted role QA vẫn **BLOCKED**, không thử lại credential
  và không tạo thêm fixture. Theo skill Vercel Firewall, Publish do người dùng
  thực hiện; agent không kích hoạt thay.
- **Kết luận:** CI PASS có cảnh báo 4 flaky; chưa đóng Ngày 6/100%. Còn hosted
  Owner/Receptionist QA, điều tra flake và nghiệm thu người mới/iPhone vật lý.
  Không thay đổi Production, không gửi thông báo/provider. Phần báo cáo bổ sung
  này chỉ lưu local, chưa commit/push.

## Điều tra bốn flake booking — tiếp tục local

- Đã tải artifact `playwright-report-shard-1` của run `35982753932` và đọc
  cả bốn error-context/ảnh: tất cả đang ở trang **Booking is paused**, không
  phải chỉ chậm hydration. Response public page là HTTP 200.
- Cơ chế liên quan: snapshot catalog được giữ tối đa 1 giây theo slug, trong
  khi entitlement được đọc mới theo salon ID. Hai spec xóa/tạo lại salon với
  cùng slug giữa các test; snapshot có thể vẫn trỏ ID đã bị xóa, nên entitlement
  từ chối đúng. Đây là va chạm danh tính fixture; không cần nới guard ứng dụng.
- `resolvePublicBookingPage.ts` và `loadBookingServices.ts` không khác `main`
  hiện tại (`f6bf087b9d6f4354c3742ee270ab6aaf78cc8d9d`). Đây là đối chiếu mã,
  không phải tuyên bố đã chạy toàn suite trên một build main riêng.
- Baseline local: `node qa/day5/run-local.mjs test --config
  qa/day6/booking-entry.config.ts --project chromium --grep
  'hours-7|idor-8|input-12|input-13|bv-2' --repeat-each 3`:
  **13 passed, 5 failed**, retries=0. Tái hiện paused ở idor-8 và input-13.
  Hai flake còn lại có cùng UI lỗi trong CI nhưng không tái hiện ở vòng local này.
- Sửa chỉ test: tạo slug riêng cho mỗi fixture trong `booking-errors.spec.ts`
  và `booking-validation.spec.ts`; giữ mọi assertion, thời gian chờ, guard,
  entitlement và ca pause/reopen cùng salon. Không thêm retry hoặc auto-reload.
- Chạy cùng grep trên cả Chromium/mobile WebKit, `--repeat-each 3`:
  **36/36 PASS**, 42.6 giây, retries=0. Đây là 6 kịch bản × 2 browser × 3 vòng.
- Config mới tái sử dụng runner loopback/real Auth/provider-OFF; lỗi đường dẫn
  teardown ở lần cấu hình đầu đã sửa trước khi test chạy. Không tính lần lỗi
  cấu hình đó là bằng chứng lỗi ứng dụng.
- `npm run typecheck`, ESLint hai spec + config, `git diff --check`: PASS.
- Chưa đổi application runtime, không build lại ứng dụng; dùng production build
  local đã kiểm chứng. Bản sửa này chưa commit/push hoặc được CI xác nhận.
- Trọn hai spec: `node qa/day5/run-local.mjs test --config
  qa/day6/booking-entry.config.ts`: **50/50 PASS**, 1.8 phút, Chromium/WebKit,
  retries=0, không skipped. Bao gồm conflict/race, hours/closure, IDOR, validation,
  XSS, Unicode và UTC/timezone; chỉ có booking synthetic trên QA local.
- Đối chiếu read-only sau teardown trên container
  `supabase_db_nailiq-day5-20260924`: salons=0, auth.users=0, bookings=0,
  client_profiles=0. Dữ liệu thử đã được xóa; có thể dựng lại bằng fixture.
- Hosted firewall vẫn có draft và `liveAllowsQa=false`; không Publish thay
  người dùng. CI PASS trước đó thuộc commit `f8526fcb`, không chứng minh bản
  sửa fixture chưa push này. **PASS_LOCAL; hosted QA BLOCKED; chưa đóng Ngày 6.**

## Phê duyệt xuất bản batch fixture

- Huy xác nhận “N” sau câu hỏi commit/push bản sửa fixture vào PR #1424 và
  chạy lại CI. Chỉ xuất bản hai spec, config local và báo cáo này; giữ PR Draft.
- Các dòng “chưa commit/push” phía trên là trạng thái trước phê duyệt.
  CI của batch mới phải được kiểm chứng riêng. Không merge, không deploy
  Production, không Publish firewall, không migration hoặc gửi thông báo.

## Hosted Computer Use — ngoại lệ QA đã active, 24/09

### Môi trường và phạm vi

- Đọc UI Vercel và `vercel firewall overview --json` xác nhận active version 12,
  updatedAt `2026-09-24T15:00:49.255Z`, draft=null. Alias QA ngày 5 có trong
  nhóm ngoại lệ writer; nhóm payment reconciliation vẫn không cho alias này.
  Agent không bấm Publish. Hai SDK rules vẫn log-only, không có system bypass.
- Preview branch `qa/day5-receptionist-20260924`; application runtime đã ghi
  nhận ở checkpoint trước là `8e220721`, không phải test-only head `3d2a85b1`.
- Fixture kiểm lại branch-only Preview env trước khi ghi: cả URL Supabase trỏ
  QA `uhpzafoiifupyypkcwln`, SMS/email/call OFF, payment workers OFF,
  card-save dispatch disabled. Không đọc/ghi tenant kinh doanh hoặc Production.
- Hai salon synthetic riêng, 3 nhân viên, 2 dịch vụ, 3 lịch synthetic,
  một hồ sơ khách và hai tài khoản Owner/Receptionist. Auth admin createUser
  đã-confirm không gửi invitation. Một password dùng tạm, không ghi vào file.
- Computer Use trong in-app browser: desktop EN rồi viewport 375×667 VI.
  Đây là mô phỏng trên Mac, không phải iPhone vật lý.

### PASS đã quan sát trực tiếp

1. Owner đăng nhập thật thành công; lỗi POST login bị WAF chặn trước đây không
   tái hiện. Trang chủ hiển thị đúng 3 lịch, 1 hoàn tất, QA Casey đang bận.
2. Trang chủ và Pulse cùng $55 (= dịch vụ $45 + add-on $10), chú thích rõ đây
   là giá trị dịch vụ hoàn tất, không xác nhận tiền đã thu.
3. Danh sách tìm bằng số synthetic mở đúng hồ sơ; Tổng chi/TB mỗi lần/lịch sử
   cùng $55; tên và ngày không bị cắt ở viewport đã xem. Escape trả focus về
   tên khách. Không bấm Mời đặt lại/Nhắn tin.
4. Cảnh báo Ngày mai mở `date=2026-09-25`; tab Ngày mai selected, reload vẫn
   giữ ngày này. UI nói SMS/email đang tắt đúng cấu hình, không báo đã gửi.
5. Owner truy cập đường dẫn Clients của salon synthetic thứ hai bị chuyển về
   salon của mình; không thấy danh sách khách của salon khác. Đây là bằng chứng
   route UI, không thay thế toàn bộ IDOR/RLS suite.

### FAIL mới: giờ lịch sử khách theo máy xem, không theo salon

- Fixture salon timezone UTC, lịch hoàn tất bắt đầu `2026-09-24T07:00:00Z`.
  Trong hồ sơ khách VI, lịch sử hiển thị **24/9/2026 00:00** thay vì 07:00 UTC.
- Root cause ở `ClientProfile360Drawer.tsx`: `formatTime` dùng
  `Date.getHours()/getMinutes()` theo timezone runtime; hai formatter ngày
  dùng `toLocaleDateString` không truyền salon timeZone. Contract
  `ClientProfile360` chưa có timezone salon. Sai khác này có thể cả giờ/ngày
  khi chủ xem từ múi giờ khác; không phải dữ liệu booking bị đổi.
- Đối chiếu các formatter với main base
  `f6bf087b9d6f4354c3742ee270ab6aaf78cc8d9d`: mã formatter giống nhau.
  Đây là lỗi có sẵn theo so sánh source, không tuyên bố đã chạy UI main.
- Mức độ trung bình: thông tin lịch sử sai cho người xem khác timezone.
  Cần truyền timezone salon từ loader đã xác minh quyền, định dạng giờ/ngày
  nhất quán, test chênh ngày và DST trước khi xuất bản. Chưa sửa trong lượt UI này.
- Metadata title còn `Clients`/`Pulse` trong VI; đã là hạn chế ghi trước đó.

### BLOCKED / cleanup

- Bấm Đăng xuất mở JS confirm. Công cụ không hoàn tất điều khiển hộp thoại:
  các thao tác được tài liệu hỗ trợ timeout tại `Emulation.setFocusEmulationEnabled`;
  API getJsDialog trả undefined. Native app host bị chặn vì an toàn nên không
  sử dụng đường đó. Không coi đây là bằng chứng lỗi đăng xuất của NailIQ.
- Do chưa hoàn tất chuyển phiên bằng UI, **Receptionist hosted NOT TESTED**.
  Không tái sử dụng phiên Owner để giả làm Receptionist. Không đánh dấu toàn
  bộ hosted QA PASS hoặc đóng Ngày 6.
- Thu hồi global sessions của đúng hai Auth user synthetic bằng Supabase QA,
  rồi cleanup fixture: **PASS, salonsRemaining=0, accountsRemoved=2**;
  script xóa các booking/client profile/staff/services/membership của riêng
  fixture. Không xóa dữ liệu ngoài lượt thử; dữ liệu synthetic có thể dựng lại.
- Viewport đã reset. Lệnh đóng tab QA bị timeout; không tuyên bố đã đóng tab.
  Membership/user của fixture đã xóa nên không còn quyền truy cập salon QA.
- Không migration, commit/push thêm, deploy, email/SMS/call/payment/provider.
  Mục báo cáo này local-only. **PASS một phần UI Owner; FAIL timezone;
  BLOCKED công cụ chuyển role; NOT PROVEN nghiệm thu người dùng/iPhone thật.**

## CI xác nhận batch fixture — 24/09, sau 14:56 UTC

- Head kiểm chứng: `3d2a85b158e1622895c01ba4ae582f707de8b7f0`.
  CI `36013530425` và E2E `36013530353` đều COMPLETED/SUCCESS.
  PR #1424 vẫn OPEN/Draft: 20 checks SUCCESS, 2 SKIPPED
  (MQA-0148 và AI Triage); không tính skipped là PASS.
- Đọc log riêng job non-RC `107680212413`: **179 passed, 2 skipped**,
  không có kết quả flaky hoặc retry # trong log. Bốn ca flaky của lần trước
  không tái xuất hiện ở lần này; không suy rộng thành cam kết không bao giờ flake.
- Các nhóm non-RC bổ sung: Guided Setup mobile 6 PASS, Reports WebKit 1 PASS,
  Superadmin authority WebKit 6 PASS, Booking capability WebKit 7 PASS,
  registration WebKit 3 PASS, booking diagnostics WebKit 10 PASS,
  group placeholders WebKit 18 PASS.
- Log settings recovery `107680212582`: **196 passed**, không ghi nhận
  flaky/retry. Các checks receptionist desktop/mobile, tenant roles,
  SuperAdmin HTTPS, visual, smoke, build/typecheck, i18n và security đều SUCCESS.
- Kiểm chứng bằng `gh pr view 1424 --json
  headRefOid,isDraft,state,statusCheckRollup`, `gh run view` cho hai run và
  `gh run view 36013530353 --job <job-id> --log`.
- **PASS_CI** cho batch fixture. Hosted Owner/Receptionist vẫn chưa PASS:
  lần đọc firewall có dữ liệu gần nhất còn draft và `liveAllowsQa=false`.
  Lần gọi CLI overview sau CI kết thúc trả exit 0 nhưng không có JSON;
  không dùng kết quả rỗng để suy ra đã publish. Không tự publish hoặc thử
  lại đăng nhập/tạo fixture khi chưa chứng minh ngoại lệ QA đã active.
- Nghiệm thu người mới/iPhone vật lý vẫn **NOT PROVEN**. Chưa đóng Ngày 6,
  không tuyên bố 100%; không merge, deploy Production, migration hoặc gửi
  thông báo/provider. Mục bằng chứng cuối này lưu local, chưa commit/push.

## Local Customer 360 timezone fix — 2026-09-24

### Current truth and scope

- This section supersedes the older WAF blocker wording above: the prior hosted
  audit recorded active WAF version 12 with no draft and a working QA owner
  login. No firewall change was made during this local fix.
- Branch remains `qa/day5-receptionist-20260924`, HEAD `3d2a85b1`; these changes
  are uncommitted. The existing CI success applies to HEAD, **not** this fix.
- Root cause: Customer 360 used the viewer's default timezone and `getHours()`.
  Its server response omitted the authorized salon timezone. Stored appointment
  instants were correct; this was a display defect.
- The response now includes `salonTimezone` from the existing authenticated
  dashboard context, with no additional database access. Timeline/upcoming and
  other profile timestamp dates use that zone. Calendar-only dates keep their
  literal day; invalid/missing timezone never falls back to the viewer's zone.
- No booking/status/financial/role/provider logic, migration, or UI primitive
  was changed. Receptionist spend redaction remains covered.

### Verification evidence

1. **RED, browser reproduced:**
   `node qa/day5/run-local.mjs test --config qa/day6/playwright.config.ts --project desktop-admin-en --grep 'real owner/admin'`
   failed before rebuilding the application: the UTC fixture's `08:30` history
   was absent with a Los Angeles viewer. This complements the hosted `07:00`
   versus `00:00` evidence recorded earlier; fixtures have different times.
2. **PASS, 27 tests:**
   `npx --offline vitest run src/shared/dashboard/__tests__/clientProfileDateTime.spec.ts src/shared/dashboard/__tests__/clientSpendAuthorization.spec.ts`.
   Covers UTC/Los Angeles/Vietnam clocks, day rollover, spring/fall DST,
   EN/VI, calendar-only expiry, invalid input, authorized timezone provenance,
   unchanged stored instants, membership rejection and existing spend privacy.
3. **PASS, timezone independence:** reran the eight formatter cases with
   `TZ=Pacific/Kiritimati` and `TZ=America/Los_Angeles`; eight passed each run.
4. **PASS, 4 existing DST tests:**
   `npx --offline vitest run src/shared/lib/__tests__/salonTimeDst.spec.ts`.
5. **PASS:** `npm run typecheck`, then `node qa/day5/run-local.mjs build`;
   these ran sequentially to avoid `.next/types` conflicts.
6. **PASS, 18/18 browser tests, retries=0:**
   `node qa/day5/run-local.mjs test --config qa/day6/playwright.config.ts owner-journey.spec.ts`.
   Six configurations: iPhone SE EN/VI, iPhone Pro Max EN/VI, iPad VI
   (WebKit emulation) and desktop admin EN (Chromium). Verifies corrected
   salon clock, owner totals, customer search, tomorrow navigation/reload,
   server date markup and cross-salon route rejection.
7. **PASS, actual computer use on local build:** synthetic owner signed in;
   searched the synthetic customer's phone; opened Customer 360; visibly
   confirmed `24/9/2026 08:30` and `$55` on desktop and 375×667 viewport.
   Switched to English and confirmed `9/24/2026 08:30`. Escape and Close
   returned focus to the customer name. No message/booking button submitted.
   Temporary viewport reset and agent-created local tab closed.
8. **Cleanup PASS:** the exact manual synthetic salon, user and profile fixture
   was removed by its cleanup routine (`Manual fixture removed; salon count=0`).
   Local server stopped. Automated fixtures also completed teardown.
9. **Checks with known warnings:** touched-file ESLint: zero errors, one existing
   unused `handleBookAgain` warning (also present at HEAD). i18n checker:
   zero errors, 13 existing warnings; no translation bundles changed.
   `git diff --check` passed. WebKit server output still reports early-closed
   streams during navigation; test assertions had no page errors/5xx and this
   fix does not claim to resolve that separate diagnostic. The manual local
   server also logged stale refresh-token errors from prior browser state;
   fresh synthetic login succeeded.

### Remaining boundary

- **PASS locally for this timezone fix; not deployed or hosted-verified.**
- Hosted receptionist flow, rerun of hosted owner after publishing this fix,
  first-time-owner acceptance and physical iPhone testing are not proven.
  Do not close Day 6 or claim 100% from these local results.
- Minor copy follow-up observed: activity-log accessible label remained
  Vietnamese after switching to English; existing Clients page title is English.
  Neither unrelated copy item was changed in this timezone batch.
- No commit, push, PR state change, Preview redeploy, Production mutation,
  migration, real notification or provider request in this local batch.
- Rollback boundary: this is display-only and additive to the response; revert
  this batch's formatter, response field and UI call sites together. No stored
  data or schema rollback is required. Preserve the earlier report evidence.

## Approved publication and hosted timezone verification — 2026-09-24

This section supersedes the unpublished/not-hosted boundary above for this
specific fix, not for the whole Day 6 acceptance plan.

- User approved commit/push into PR #1424 and Preview redeploy, keeping Draft.
  Published commit: `6c31974ac4568e30fb083b459462fe9a1b9f62cb`.
- Preview deployment `dpl_BT1f9uLZgdFWZt5ivgCNr1TboxX5`: READY.
  URL: https://nailiq-m4pi3h1yl-bepnhobencha-2588s-projects.vercel.app
  Branch alias: https://nailiq-git-qa-day5-reception-b8704e-bepnhobencha-2588s-projects.vercel.app
  Browser `/api/version` visibly returned the exact published SHA.
- Read-only environment preflight: 60 branch-scoped Preview variables; QA ref
  `uhpzafoiifupyypkcwln`; 32 provider credentials blank; outbound SMS/email/call
  and payment/provider workers disabled. No environment or WAF changes made.
  Initial REST create attempt rejected `target: preview` before creation;
  corrected by omitting target, then exactly one new Preview was created.
- Synthetic fixture: two isolated QA salons, two auth users (owner and
  receptionist), three staff, two services, three bookings and one customer
  profile. UTC salon; completed booking at 07:00 UTC with service 45 + add-on
  10. This fixture time differs from local automated 08:30 fixture.
- **Hosted computer-use PASS, owner:** authenticated through the real login
  form, opened customer detail, saw 07:00 salon time and $55 completed service
  value. Verified Vietnamese desktop and Vietnamese/English 375x667 mobile.
  English displayed `9/24/2026 07:00`; Vietnamese `24/9/2026 07:00`.
  Mobile screenshot showed contained content and accessible footer actions.
  Escape and Close returned focus to the customer name. No Book again or
  Message action was submitted.
- **Hosted computer-use PASS, receptionist:** revoked only the synthetic owner
  session via QA admin API, reloaded to login and signed in as receptionist.
  List displayed spend as an em dash; detail omitted lifetime/average amounts
  and timeline price, while keeping the correct 07:00 time and operational
  history. Direct navigation to the other synthetic salon's clients route
  redirected to the user's own salon without displaying its client list.
  This confirms the tested route behaviour, not exhaustive IDOR coverage.
- Fixture inspection before teardown: three original booking statuses and
  amounts unchanged. No additional booking was created through the UI.
- **Cleanup PASS:** closed the test tab, reset viewport, globally revoked the
  two synthetic users' sessions, removed both fixture salons and their exact
  child records, removed the synthetic profile and two auth users. Cleanup
  receipt: `sessionsRevoked=true`, `salonsRemaining=0`, `accountsRemoved=2`.
  Disposable test records are permanently removed; no live salon touched.
- Read-only Production deployment comparison remained
  `dpl_FX3WJBMueRCword7mwJyyhafPNPc`, READY, SHA
  `f6bf087b9d6f4354c3742ee270ab6aaf78cc8d9d`.
- CI snapshot after hosted QA: 19 checks SUCCESS (including Vercel), one
  SKIPPED; non-RC and settings-recovery checks still running. Receptionist
  mobile passed. Build/typecheck, security, smoke, receptionist desktop, tenant
  roles/session revocation, SuperAdmin HTTPS and visual regression PASS.
  Runs: CI `36020134066`, E2E `36020134065`. Pending is not PASS.
- Known minor copy findings remain: English UI has Vietnamese activity-log
  accessible label and some document titles do not track current language.
  First-time-owner comprehension and a physical iPhone remain NOT PROVEN.
- **PASS for hosted verification of this timezone/role-display fix.** Day 6
  is not closed and no 100% claim is made. PR remains OPEN/Draft. No merge,
  Production deploy, migration, notification or external provider call.
  This follow-up evidence is local/uncommitted after the single approved push.

## Final CI closeout for published head — 2026-09-24

- Refreshed PR #1424 at exact head
  `6c31974ac4568e30fb083b459462fe9a1b9f62cb`: OPEN/Draft, **22 checks
  SUCCESS, 2 SKIPPED, zero pending/in-progress and zero failed checks**.
  This supersedes the pending snapshots above. Skipped checks are MQA-0148
  and AI Triage, not acceptance passes.
- Read individual completed job logs through GitHub API (the CLI refused to
  retrieve job logs while the overall workflow was still running):
  - receptionist Chromium `107702863049`: **109 passed, 4 skipped**;
  - receptionist mobile `107702863022`: **103 passed, 10 skipped**;
  - non-RC `107702863072`: **179 passed, 2 skipped**, plus Guided Setup 6,
    Reports WebKit 1, Superadmin authority 6, booking capability 7,
    registration 3, complete booking diagnostics 10, group placeholders 18;
  - real-auth settings recovery `107702863067`: **196 passed (17.6 minutes)**.
  No flaky/retry summaries found in these filtered test-result logs. This is
  not a guarantee that future runs cannot flake.
- Completed server logs still contain `The destination stream closed early.`
  in desktop/mobile/recovery outputs. Preserve the previous diagnostic
  boundary: assertions passed, but do not claim perfectly clean runtime logs
  or that every historical/Production stream abort has been explained.
- Updated the current acceptance index and existing iPhone handoff sheet
  locally. Five physical-device tasks now have explicit blank result fields;
  they remain NOT PROVEN, not automatically passed by the CI results.
- **PASS_CI + PASS_HOSTED for the documented scope.** No source-code changes,
  new commit/push, PR-state change, deployment, database/provider activity or
  notifications during this CI closeout turn. Documentation-only diff check
  PASS; application typecheck/build not rerun for documentation-only changes.
- Day 6 remains open for V1-24 physical-iPhone/new-owner acceptance and release
  authorization. V1-21 new receptionist timing remains separately open.

## Review tập trung trước phát hành — 24/09/2026

- Đọc lại diff runtime từ base `f6bf087b9d6f4354c3742ee270ab6aaf78cc8d9d`
  tới head `6c31974ac4568e30fb083b459462fe9a1b9f62cb`, cùng các caller và
  regression liên quan. PR #1424 vẫn OPEN/Draft; không thay đổi trạng thái PR.
- Review tập trung: query availability và trạng thái in-progress; phép chiếu
  khoảng trống walk-in; số tiền dịch vụ/add-on tách khỏi receipt thanh toán;
  membership/role trước đọc hồ sơ; thời gian salon; phản hồi tải ngày/tìm kiếm
  đến trễ; trạng thái Loyalty qua refresh; focus của form/drawer; thay đổi
  fixture để tránh cache trỏ ID salon đã xóa. Hướng dẫn React và checklist
  Supabase được dùng để rà vòng đời state và ranh giới quyền.
- Không tìm thấy lỗi P0/P1 mới có thể xác lập từ phần diff đã rà. Đây là review
  tập trung, không phải security audit toàn hệ thống hoặc bằng chứng rằng
  mọi ca thực tế đều không có lỗi. Không sửa source để tạo thêm công việc.
- Chạy mới 10 suite unit: **122/122 PASS, 10/10 files PASS**, 376ms;
  không skipped. Lệnh:

```sh
./node_modules/.bin/vitest run src/shared/dashboard/__tests__/availabilityEngineSequence.spec.ts src/shared/dashboard/__tests__/clientProfileDateTime.spec.ts src/shared/dashboard/__tests__/clientSpendAuthorization.spec.ts src/shared/dashboard/__tests__/ownerPulseAttentionHref.spec.ts src/shared/dashboard/__tests__/receptionistDaySnapshot.spec.ts src/shared/dashboard/__tests__/receptionistKpiWindow.spec.ts src/shared/dashboard/__tests__/serviceValueCents.spec.ts src/shared/dashboard/__tests__/walkinGapSafety.spec.ts src/shared/lib/__tests__/waitlistPresentation.spec.ts src/components/receptionist/__tests__/receptionistLocale.spec.ts
```

- Runner có warning về Vite native config loader trong phiên bản tương lai;
  không ẩn warning và không đổi cấu hình ngoài phạm vi review. `git diff
  --check` PASS. Không chạy lại build/full browser suite vì source không đổi;
  bằng chứng CI/hosted trước đó vẫn được ghi riêng ở trên.
- Còn copy/title nhỏ EN/VI và stream-abort đã ghi trong report; chưa có bằng
  chứng iPhone vật lý/người mới. Không tính việc gửi link là đã nghiệm thu.
- Ranh giới release: `vercel.json` giữ `main: false` có sẵn và khóa Git deploy
  của nhánh QA. Không hứa merge sẽ tự deploy Production; khi được phê duyệt
  cần xác minh cơ chế phát hành hiện hành và exact SHA riêng. Không migration.
- Lượt review chỉ đọc source/GitHub, chạy unit có mock và bổ sung tài liệu
  local. Không commit/push, merge/deploy, database mutation, provider hoặc
  thông báo. Ba báo cáo local có sẵn được giữ nguyên các thay đổi trước đó.

## Phê duyệt xuất bản báo cáo và chuyển review — 24/09/2026

- Huy trả lời “n” xác nhận đề nghị commit/push đúng ba báo cáo QA và chuyển
  PR #1424 sang Ready for review; không merge/deploy Production.
- Batch này chỉ cập nhật `MASTERPLAN_ACCEPTANCE_CURRENT.md`, báo cáo này
  và `masterplan-day-6-admin-handoff-2026-09-24.md`. Không đổi runtime,
  migration, cấu hình, dữ liệu hoặc quyền salon.
- Các trạng thái Draft/local ở trên là checkpoint lịch sử. CI và hosted
  evidence ở SHA `6c31974` không được gán thành kết quả CI của commit tài liệu
  mới; Preview hiện có vẫn là ứng viên runtime đã kiểm chứng.
- Ready for review chỉ là sẵn sàng để xét duyệt, không phải xác nhận V1-21,
  V1-24, ngày 6 hoặc Master Plan đạt 100%. Giữ toàn bộ mục chưa nghiệm thu.

## CI của commit tài liệu và điều tra WebKit — 24/09/2026

- PR #1424 OPEN/Ready, head `04c7adf11e451e4ae0ac4bdfc64ac11dad76e141`.
  Runtime không đổi so với `6c31974`; worktree sạch trước lượt điều tra này.
- [E2E run 36024787391](https://github.com/bepnhobencha-rgb/nailiq/actions/runs/36024787391):
  receptionist desktop **109 passed / 4 skipped**, mobile **103 passed /
  10 skipped**, settings recovery **196 passed**. Non-RC FAIL làm gate tổng
  hợp FAIL; không phải hai lỗi độc lập. Snapshot cuối: 19 SUCCESS, 2 FAILURE,
  1 SKIPPED. AI triage SUCCESS không phải bằng chứng sửa lỗi.
- Job non-RC `107718614804`, substep booking diagnostics: **9 passed /
  1 failed**, `--repeat-each=10 --retries=0`. Repeat 7 thất bại ở
  `e2e/booking.spec.ts:77`, sau assertion `booking-success` visible đã PASS.
- Artifact `playwright-report-shard-1`, attachment
  `booking-submission-diagnostics`: RPC create HTTP 200; response body được
  kiểm tra riêng xác nhận `success=true` và có booking ID (không sao chép ID
  hay contact vào báo cáo). Card-capability/Wix bridge trả 200/ok; đây là QA
  với provider OFF, không chứng minh provider thật đã thực hiện tác vụ.
- Có event `page-crash` ở khoảng 31.37 giây. Trace cho thấy assertion success
  visible hoàn tất, sau đó khoảng 24 giây trước pageClosed; evaluate sau đó
  trả `Target crashed`. Snapshot sau success bị thiếu; ảnh cuối vẫn ở
  Submitting. Không gọi đây là bằng chứng hình ảnh màn hình success đã render
  hoàn chỉnh, cũng không quy thành booking thất bại hay tự động gửi lại.
- Không có pageerror trong attachment. Đây là dấu hiệu browser process
  crash, **nguyên nhân gốc chưa xác định** (không khẳng định OOM, lỗi WebKit,
  app hay tracing). Test và DonePanel không có diff so với base `f6bf087`;
  điều đó chưa loại trừ thay đổi gián tiếp hay khác biệt môi trường.
- Đã chạy lại local macOS, production build và Supabase loopback cô lập,
  không dotenv/provider credentials. Thêm config chẩn đoán kế thừa guard
  local-only, giữ nguyên test/assertion, trace/video khi FAIL:

```sh
node qa/day5/run-local.mjs test --config qa/day6/booking-submit-diagnostic.config.ts --grep 'Complete booking end-to-end' --project=mobile --repeat-each=10 --retries=0
```

  **10/10 PASS, 50.6 giây, không retry**, teardown hoàn tất. Lượt đầu chưa
  chạy được test vì sandbox npm offline cache; sau phê duyệt quyền truy cập
  local runner chạy thành công. Không tính lỗi cache là lỗi NailIQ.
- Bổ sung `DEBUG=pw:browser` chỉ cho substep này để lần CI kế tiếp lưu native
  stderr/exit evidence, theo [Playwright CI debugging](https://playwright.dev/docs/ci#debugging-browser-launches).
  Không bật `pw:api`/`pw:protocol`, không thay retry/timeout/assertion, không
  thay app, policy hay database. Thay đổi này **local-only, chưa kiểm chứng
  trên CI**; cần phê duyệt commit/push batch chẩn đoán trước lần chạy mới.
- Kiểm tra local bổ sung: `npx tsc --noEmit`, ESLint cho config mới và
  `git diff --check` PASS. Workflow parse bằng `js-yaml` PASS; kiểm tra giữ
  `--repeat-each=10 --retries=0` và chỉ bật `DEBUG=pw:browser` PASS. Report
  JSON nằm trong `test-results/` bị git-ignore, không đưa artifact vào commit.
  Không chạy lại Next build vì không thay runtime/app code.
- **FAIL cho gate phát hành; PASS cho 10 local repeats; NOT PROVEN cho root
  cause và iPhone vật lý.** Không merge/deploy, migration, email/SMS/payment
  hoặc provider call. Fixture iPhone hosted trước đó giữ nguyên, không bị
  teardown local đụng tới.

### Phê duyệt batch chẩn đoán

- Huy trả lời “Duyệt” cho commit/push đúng batch chẩn đoán vào PR #1424
  và chạy CI tiếp. Phạm vi gồm workflow logging, config tái hiện local và
  hai báo cáo QA. Không merge/deploy, migration hoặc thông báo/provider.
- Kết quả CI mới phải được đọc theo SHA sau push; phê duyệt xuất bản không
  chuyển lỗi WebKit lịch sử thành PASS hoặc đóng nghiệm thu thiết bị thật.
