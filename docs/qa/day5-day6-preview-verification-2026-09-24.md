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
