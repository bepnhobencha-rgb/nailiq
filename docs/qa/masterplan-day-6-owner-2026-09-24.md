# Ngày 6 — Chủ salon / Admin trên điện thoại

Ngày kiểm tra: 23–24/09/2026 Vancouver, 24/09 UTC. Phạm vi lấy từ Giai đoạn 3
của `docs/MASTER_PLAN.md`, không đồng nhất số giai đoạn với số ngày.

## Ranh giới bằng chứng

- Worktree: `/private/tmp/nailiq-day5-receptionist-20260924`.
- Branch: `qa/day5-receptionist-20260924`, base `f6bf087b9d6f4354c3742ee270ab6aaf78cc8d9d`.
- Giữ nguyên phần sửa ngày 5; ngày 6 là batch riêng trong cùng QA worktree.
- Chỉ Supabase local `127.0.0.1:54321`, DB local 54322, app 3117.
- Auth Owner/Admin thật trong QA, không demo cookie. Tài khoản và salon giả
  được tạo bằng fixture rồi dọn. Không khóa provider được truyền vào app;
  SMS/email/call/payment dispatch đều OFF; browser chỉ được đi tới app/QA local.
- Không Production, không migration, không commit/push/PR/deploy.

## Lỗi đã xác minh và sửa local

1. **Cảnh báo ngày mai mở hôm nay.** Computer Use tiếng Việt trên khung 375×667:
   bấm “Ngày mai chưa có hẹn nào” tới `/center`, tab Hôm nay vẫn được chọn.
   E2E trước sửa xác nhận href thiếu `date`. Sửa dùng ngày salon của snapshot,
   không lấy ngày máy người xem; giữ riêng đường dẫn Waitlist. Có test DST,
   giao thừa và múi giờ Los Angeles khác UTC.
2. **Kinh doanh bỏ sót giá dịch vụ phụ.** Fixture $45 + $10: Trang chủ $55,
   Pulse $45. E2E trước sửa FAIL ở kỳ vọng `$55` trên Pulse. Cả hai màn hình
   nay dùng cùng phép cộng giá dịch vụ và dịch vụ phụ; benchmark tuần trước
   của Pulse cũng đọc/cộng add-on. Không thay đổi tiền đã thu hay sổ thanh toán.
3. **Doanh thu chưa nói rõ nguồn.** Thêm EN/VI cạnh số liệu: giá trị dịch vụ
   hoàn tất không phải bằng chứng tiền đã thu. Không giả định thu tiền thành công.
4. **Tích điểm lẫn tiếng Anh.** Computer Use thấy `Loyalty`, `Setup`,
   `No program configured` trong giao diện VI. Bổ sung các chuỗi EN/VI của
   widget, nhãn input số điện thoại, `type=tel`, vùng chạm tối thiểu 44px.
   Không bật tính năng, không thay đổi luật hoặc tự cộng điểm.
5. **WebKit lỗi tải nền Cài đặt khi reload lịch.** Lượt cuối trước sửa đạt
   11/12, lỗi `pageerror` tại stage `reload`, URL RSC `/settings`. Link phụ
   “Cài đặt gửi tin” dùng prefetch mặc định. Tắt prefetch riêng link này;
   không bỏ assertion, không thay ACL hoặc error reporter. Ca SE EN chạy riêng
   2/2, sau đó cả matrix **12/12 PASS, retries=0**. Đây là bằng chứng QA của
   đường dẫn đã tái hiện, không chứng minh hết mọi lỗi hủy request/mạng.
6. **Hồ sơ chi tiết khách cũng bỏ phụ phí.** Computer Use sau lượt matrix đầu
   thấy danh sách khách $55 nhưng Tổng chi/TB mỗi lần/Lịch sử trong drawer $45.
   Thêm 4 regression cases và xác nhận đều FAIL trước sửa. Loader chi tiết
   nay đọc/cộng add-on trong fallback giá trị dịch vụ và giá lịch sử; vẫn ưu tiên
   dữ liệu thanh toán đã đồng bộ theo quy tắc hiện có, không cộng hai nguồn.
   Chú thích EN/VI nêu rõ nguồn số liệu; receptionist vẫn không thấy số tiền
   hoặc nguồn tài chính. Không gọi AI/provider hoặc sửa payment ledger.
7. **Nhãn trợ năng khách hàng lẫn tiếng Anh.** Sửa kiểu hiển thị, lọc theo nhóm,
   phân trang và nút đóng drawer theo ngôn ngữ. Không đổi quyền hoặc thao tác ghi.
8. **Lần ghé cuối bị cắt trên điện thoại.** KPI hồ sơ khách nay dùng hai cột
   dưới breakpoint `sm`, bỏ ellipsis ở giá trị và cho phép xuống dòng. Không
   đổi dữ liệu hoặc quyền xem tài chính. E2E kiểm cả kích thước nội dung/CSS,
   không chỉ đọc textContent vốn vẫn có đủ ngày ngay cả khi bị cắt.
9. **Tab lịch khởi tạo nhầm Hôm nay.** Khởi tạo offset từ ngày đã chọn và
   snapshot giờ salon mà server cung cấp; dùng cùng helper khi đồng hồ đổi ngày.
   Giữ thao tác chọn ngày, trạng thái tải và rollback lỗi như trước. Bổ sung
   ca hôm qua/hôm nay/ngày mai/ngày khác, DST, giao thừa và qua nửa đêm.
10. **Nhãn lịch/báo cáo còn tiếng Anh.** Nhãn trợ năng tablist `Day` theo EN/VI;
    `No-show` trong Pulse VI thành `Vắng mặt`, nguy cơ được mô tả bằng tiếng Việt.
11. **Tên khách dài tràn phần đầu hồ sơ.** Computer Use 320×568 thấy tên
    synthetic không có khoảng trắng tràn khỏi cột cạnh avatar. Cho heading
    xuống dòng trong cột hiện có; fixture E2E đổi sang tên dài và kiểm
    `scrollWidth/clientWidth` của heading khi drawer đang mở.

## Năm việc kiểm thử

| Việc | Tiêu chí trong QA |
|---|---|
| Trang chủ | Auth thật, trạng thái nhân viên, 4 lịch, 1 hoàn tất; Refresh không mất số liệu |
| Doanh thu | UI đối chiếu DB: $45 + $10 = $55; chú thích không phải tiền đã thu |
| Khách hàng | Tìm tên/số điện thoại, mở hồ sơ đúng người, đóng Escape, tìm không có kết quả |
| Lịch | Cảnh báo mở đúng ngày mai; reload trang đã tải xong giữ ngày; mở lịch hôm nay và trả focus khi đóng |
| Cảnh báo/quyền | Đi đúng nơi xử lý; Owner/Admin không mở báo cáo/danh sách salon khác |

Matrix: iPhone SE WebKit EN/VI, iPhone 14 Pro Max WebKit EN/VI,
iPad WebKit VI, desktop Chromium Admin EN. Đây là emulation, không iPhone vật lý.

## Kiểm thử và lịch sử lỗi

- Unit mới: 8 ca đường dẫn/ngày và 5 ca phép cộng giá trị dịch vụ.
- Bộ unit hồi quy ngày 5 + Owner/financial/loyalty: **234/234, 24 files PASS**.
- Sau sửa hồ sơ khách, chạy lại bộ mở rộng: **274/274, 29 files PASS**, gồm
  client spend authorization, tenant staff boundary và security contracts.
- Sau sửa prefetch, unit NotificationDeliveryRescueCard: **4/4 PASS**;
  typecheck, optimized build và ESLint file sửa PASS.
- Typecheck PASS sau sửa thiếu tham số slug trong helper QA; lần build đầu FAIL
  do chính lỗi test harness này, không phải lỗi ứng dụng bị che.
- Build Next optimized với cấu hình QA: PASS; không deploy.
- ESLint các file ngày 6: 0 lỗi, 0 warning.
- Sau mở rộng file hồ sơ khách: 0 lỗi, 1 warning `handleBookAgain` chưa dùng;
  đã đối chiếu `git show HEAD:...ClientProfile360Drawer.tsx`, warning có từ base.
- i18n: 0 lỗi, 13 warning có sẵn. Vite có cảnh báo cấu hình CommonJS/ESM.
  Lượt CLI `npm run check:i18n` sau cùng bị sandbox EPERM ở IPC của tsx;
  chạy đúng script bằng `node --import tsx scripts/check-i18n.ts` PASS.
- E2E từng phát hiện fixture chỉ set localStorage mà thiếu cookie ngôn ngữ:
  sửa harness để giống thao tác toggle thật, không sửa product để che lỗi harness.
- Các lượt đầu có WebKit pageerror `due to access control checks` ở lúc
  ép chuyển trang hoặc reload giữa RSC prefetch (ghi stage `clients`, `reload`).
  Test hành trình chuyển sang bấm link thật; WebKit reload sau network đã yên,
  Chromium sau hydration (background polling không cho networkidle kết thúc).
  Chỉ thay harness vẫn còn 11/12, nên đã sửa prefetch như mục 5 ở trên.
  Không lọc/xoá pageerror; assertion lỗi JS vẫn giữ nguyên. Stress reload giữa
  chừng là bằng chứng chưa đóng riêng, không được biến thành PASS bằng retry.
- Server còn `The destination stream closed early` khi navigation/teardown.
  Diagnostic ngày 5 đã chứng minh một số abort; không quy toàn bộ warning mới
  hoặc Production cho cùng nguyên nhân khi chưa correlation từng request.

## Lệnh tái lập

```sh
node qa/day5/run-local.mjs test --config qa/day6/playwright.config.ts
node qa/day5/run-local.mjs test p0-tenant-auth.spec.ts --project=desktop-en --reporter=list --output=test-results/day6-tenant
npm run typecheck
node qa/day5/run-local.mjs build
npm run check:i18n
git diff --check
```

Runner có guard local/suppression và không đọc dotenv. Các lệnh test/build
được chạy tuần tự đối với `.next/types`. Không dùng test count làm phần trăm
hoàn tất chức năng hoặc chứng cứ pilot.

## Chưa được ký đóng toàn bộ

- V1-24: chưa người chủ mới sử dụng một tay trên iPhone vật lý.
- Preview/Production chưa được kiểm chứng với batch sửa này; chưa được phát hành.
- Đã kiểm UI tra cứu thẻ của chương trình được cấu hình trên QA; cộng/trừ điểm
  và đổi quà vẫn bị khóa an toàn, chưa được nghiệm thu hoạt động thật.
- Chưa chứng minh mọi lỗi mạng/refresh đột ngột và mọi cảnh báo ngoại lệ.
- Đã bổ sung kiểm tra 52 khách qua ba trang; chưa chứng minh mọi trạng thái
  phân trang khi dữ liệu bị xóa đồng thời. Metadata title vẫn có `Clients`/`Pulse`.
  Hạn chế KPI bị ellipsis và tab SSR nhầm Hôm nay đã
  sửa trong lượt bổ sung dưới đây; không được dùng kết quả build cũ để chứng minh.
- Danh sách khách dùng giá trị dịch vụ, hồ sơ chi tiết có thể ưu tiên thanh toán
  đã đồng bộ; đã giải thích nguồn ở hồ sơ, không hứa mọi số luôn bằng nhau.
  Không thay chính sách fallback/số 0, giới hạn 300 lịch hoặc AI summary cũ.

## Kết quả matrix cuối

- **12/12 PASS**, 6 cấu hình màn hình/ngôn ngữ × 2 ca, 1.3 phút, không retry.
- Mỗi hành trình có giữ assertion toàn bộ `pageerror` và HTTP 5xx của app;
  không lọc thông báo lỗi để đạt PASS.
- Cross-salon: cả 6 cấu hình bị chặn khỏi báo cáo/danh sách khách salon khác.
- Sau sửa bổ sung hồ sơ khách, chạy lại **12/12 PASS**, 1.3 phút; không dùng
  kết quả của build cũ để chứng minh thay đổi cuối.
- Tenant/role real-Auth trên build cuối: **9/9 PASS**, 10.1 giây. Gồm năm role,
  session revocation, khác salon, hạ quyền khi form còn mở EN/VI.
- **Computer Use build cuối, 375×667, VI, Owner Auth thật:** Trang chủ có 4
  lịch/1 hoàn tất/$55; khách tìm theo điện thoại có $55 ở danh sách, Tổng chi,
  TB/lần và lịch sử; chú thích tiền đúng; nhãn Đóng/Kiểu hiển thị/Lọc theo nhóm
  đã Việt hóa; Escape trả focus về tên khách. Pulse $55; cảnh báo ngày mai
  tới `date=2026-09-25`, tab Ngày mai selected sau hydration và reload;
  không scroll ngang. Không bấm Mời đặt lại/Nhắn tin hoặc phát sinh gửi tin.
- Hai fixture Computer Use đều dọn sau dùng. Kiểm tra DB QA local cuối bằng
  SELECT count: **salons=0, auth.users=0, bookings=0, client_profiles=0**.
  Đã đóng tab tạm, reset viewport và dừng app QA local.

## Lượt bổ sung 24/09 — bố cục và ngày ban đầu

- Bộ hồi quy mở rộng: **284/284, 29 files PASS**; tăng 10 ca ngày/locale.
- `npm run typecheck`: PASS, chạy trước optimized build QA. Build cuối PASS.
- ESLint file sửa: 0 lỗi; giữ 1 warning `handleBookAgain` đã có từ base.
- `node --import tsx scripts/check-i18n.ts`: 0 lỗi, 13 warning có sẵn.
- Lượt mở rộng đầu: 12/18 PASS, 6 FAIL do harness đòi tab **visible** khi
  tắt JavaScript. Screenshot xác minh Next Suspense còn ở loading shell;
  phần HTML stream cần JS để reveal. Sửa harness kiểm DOM server đã gắn,
  không thay product hoặc bỏ kiểm `aria-selected`. Ca riêng SE VI 1/1 PASS.
- Sau đó matrix **18/18 PASS, 1.5 phút, retries=0**. Sáu ca mới mở HTML với
  JavaScript disabled và phiên Owner/Admin thật, kiểm hôm qua/hôm nay/ngày mai/
  ngày +7. Đây là kiểm markup trước hydration, không hứa ứng dụng dùng được
  khi tắt JavaScript.
- Computer Use phát hiện tên dài tràn cạnh avatar. Sau sửa, build lại và
  đổi fixture sang `Te2eGuestDaySixLongCustomerName`; chạy lại toàn matrix
  **18/18 PASS, 1.5 phút** trên build cuối. Kiểm chiều rộng heading, KPI,
  trang khi drawer mở; không retry hay lọc pageerror.
- Computer Use cuối, VI 320×568, Owner Auth thật: tên dài xuống dòng trong
  cột, Lần cuối `24/9/2026` đầy đủ, Tổng chi/TB $55, Escape trả focus về tên
  khách. Không bấm Nhắn tin/Mời đặt lại. Đóng tab và reset viewport.
- Cảnh báo server stream-abort vẫn được giữ riêng. Lượt manual đầu có log
  refresh-token-not-found quanh phiên synthetic đã xóa; lượt cuối đóng tab
  trước cleanup và server không ghi lỗi này. Không suy ra Production bị lỗi.
- Dọn cả hai fixture thủ công và toàn bộ fixture E2E. SELECT count cuối:
  **salons=0, auth.users=0, bookings=0, client_profiles=0**. App đã dừng.
- Không migration/commit/push/Preview/deploy/Production/provider thật.

Lệnh trọng tâm bổ sung:

```sh
npx vitest run src/shared/dashboard/__tests__/receptionistDaySnapshot.spec.ts src/components/receptionist/__tests__/receptionistLocale.spec.ts
node qa/day5/run-local.mjs test --config qa/day6/playwright.config.ts --project=se-vi --grep 'initial HTML'
node qa/day5/run-local.mjs test --config qa/day6/playwright.config.ts
```

## Lượt bổ sung 24/09 — tìm kiếm và phân trang khách

### Lỗi tái hiện và bản sửa local

- Nút phân trang cao 38px và bị Coco/thanh điều hướng che ở màn hình hẹp.
  Tăng vùng chạm tối thiểu 44px, thêm khoảng cuộn cuối danh sách và scroll margin;
  nút kiểu hiển thị/nhóm khách cũng có vùng chạm 44px.
- Timer tìm kiếm còn chờ có thể gọi trang 1 sau khi người dùng đã bấm trang 2/3.
  Dùng trang của response đã hoàn tất; khóa phân trang khi query đang chờ;
  đánh số request để không nhận response cũ. Không sửa RPC/schema hay quyền.
- Tách thông báo không tìm thấy khách khỏi danh sách chưa có khách, EN/VI;
  lỗi đọc/rejected request có thông báo và nút Thử lại, không giả vờ danh sách rỗng.

### Bằng chứng và giới hạn

- Thêm `qa/day6/client-directory.spec.ts`: 52 khách synthetic, ba trang 25/25/2,
  tên/số điện thoại, ba kiểu hiển thị, query không có kết quả, lỗi 503 và retry.
  Sáu cấu hình Owner/Admin, WebKit/Chromium, EN/VI; không ghi dữ liệu qua UI.
- Baseline mới 0/2 FAIL; sau sửa product, lượt mở rộng đầu 19/24 PASS.
  Năm FAIL WebKit do harness không intercept được request với service worker.
  Test directory chặn service worker theo
  [hướng dẫn Playwright](https://playwright.dev/docs/network#missing-network-events-and-service-workers),
  nên đây không phải bằng chứng offline/PWA. Đi tới Clients bằng link UI sau
  Home thay vì hard navigation để không abort các request Home còn chạy.
  Không lọc `pageerror` để đạt PASS.
- **Matrix cuối 24/24 PASS, 2.1 phút, 1 worker, retries=0**, trên optimized build
  chứa bản sửa. Unit liên quan **49/49 PASS, 5 files**; không chạy lại toàn bộ
  284 unit của lượt trước. Typecheck, optimized build, ESLint file sửa và diff
  check PASS. i18n: 0 lỗi, 13 warning có sẵn.
- Computer Use riêng, Owner Auth thật, VI 320×568: tìm đủ 52 khách, chuyển
  trang 1 → 2 → 3, trang cuối đúng hai khách, nút Tiếp disabled; screenshot
  xác nhận phân trang nằm trên Coco, có thể bấm bình thường. Đổi Chi tiết và
  tìm tên không tồn tại: `0 khách`, thông báo tiếng Việt rõ, không tràn ngang.
- Server còn log stream-abort và refresh-token-not-found quanh vòng đời tài
  khoản QA synthetic. Chưa xác định đầy đủ mọi nguồn; không gọi là log sạch,
  không suy ra lỗi Production. Không chứng minh xóa khách đồng thời trên trang
  cuối, mọi thứ tự response hoặc iPhone vật lý/chủ salon mới.
- Loyalty có giá trị thật vẫn chưa test; `LOYALTY_VALUE_MUTATIONS_ENABLED=false`
  được giữ nguyên. Không bật cộng/trừ điểm để ép test PASS.
- Đóng tab trước cleanup, reset viewport, dọn fixture; SELECT count cuối:
  **salons=0, auth.users=0, bookings=0, client_profiles=0**. Dừng app local.
  Không migration, commit, push, Preview, deploy, Production hay provider thật.

Lệnh xác minh lượt này (typecheck/build chạy tuần tự):

```sh
npm run typecheck
node qa/day5/run-local.mjs build
node qa/day5/run-local.mjs test --config qa/day6/playwright.config.ts
npx --offline vitest run src/shared/dashboard/__tests__/clientSpendAuthorization.spec.ts src/shared/dashboard/__tests__/ownerPulseAttentionHref.spec.ts src/shared/dashboard/__tests__/serviceValueCents.spec.ts src/shared/dashboard/__tests__/receptionistDaySnapshot.spec.ts src/components/receptionist/__tests__/receptionistLocale.spec.ts
npx --offline eslint src/components/dashboard/ClientProfilesPanel.tsx qa/day6/client-directory.spec.ts qa/day5/manual-fixture.ts qa/day6/playwright.config.ts
node --import tsx scripts/check-i18n.ts
git diff --check
```

## Lượt bổ sung 24/09 — tích điểm chỉ xem và lỗi tra cứu

### Lỗi tái hiện

- Chương trình QA đã cấu hình, thẻ có 3 điểm: UI cho bấm `+1/−1` trong khi
  `LOYALTY_VALUE_MUTATIONS_ENABLED=false` ở server. Không bấm để cộng/trừ thật.
- Đổi số điện thoại vẫn thấy thẻ của số trước, có thể đọc nhầm điểm của khách.
- POST tra cứu trả 503 không có thông báo phục hồi; số điểm trong giao diện VI
  vẫn ghi `stamps`.
- Computer Use VI 320×568 phát hiện Coco che dòng không tìm thấy thẻ. Sau phát
  hiện này đã thêm khoảng trống cuối widget, build và chạy lại (không lấy kết
  quả của bản trước để thay cho bản cuối).

### Sửa local

- Widget dùng cùng hằng khóa với server: thông báo EN/VI chỉ xem, nút cộng/trừ
  disabled và handler cũng chặn; không thay hằng khóa hoặc đường ghi server.
- Xóa kết quả cũ ngay khi sửa số, bỏ response tra cứu cũ khi input đã đổi hoặc
  widget bị tháo; bắt lỗi mạng để hiện hướng dẫn thử lại. Nút Tra cứu dùng
  primitive Button, giữ nhãn khi loading, số trống không gửi request.
- `StampCard` thêm prop đơn vị điểm; mặc định vẫn là `stamps` cho các surface
  cũ. Chỉ widget dashboard truyền nhãn VI, không đổi chính sách phần thưởng.
- Khoảng trống mobile áp dụng cả nhánh tải thành công; giữ nguyên layout desktop.

### Kiểm chứng và an toàn

- Baseline mới **1 FAIL** với các assertion khóa nút/ẩn thẻ cũ/phục hồi lỗi.
  Cleanup baseline gặp FK không cascade của loyalty_cards; đã dọn đúng tenant
  synthetic và thêm cleanup events → cards → program trước khi xóa salon.
- Focused sau sửa: SE VI + desktop Admin EN **2/2 PASS**; matrix đầu **30/30
  PASS, 2.3 phút, retries=0**. Sau sửa khoảng trống Coco, focused **2/2 PASS**
  với assertion hit-test thông báo không bị lớp nổi che.
- Matrix cuối trên bản đã sửa khoảng trống Coco: **30/30 PASS, 2.3 phút,
  retries=0**. Computer Use đăng nhập lại Owner synthetic ở 320×568: dòng
  không tìm thấy thẻ hiển thị đầy đủ phía trên Coco; tra lại thẻ có 3/10 điểm,
  cả hai nút cộng/trừ đều disabled. Đã đóng tab thử và trả viewport về mặc định.
- Cleanup cuối: salon, Auth user, booking, client profile, loyalty card,
  loyalty program và stamp event đều **0** trong stack disposable local;
  dòng platform flag Loyalty không còn, khớp trạng thái trước fixture.
- Unit **54/54 PASS, 7 files**, gồm valueMutationSafety và loyaltyRolloutBoundary.
  Typecheck/build chạy tuần tự PASS; ESLint file sửa/diff check PASS;
  i18n 0 lỗi, 13 warning có sẵn. Không chạy lại toàn bộ unit repository.
- Browser test đọc hai thẻ 3/10 và 7/10, đổi số, không có thẻ, lỗi mạng đúng
  action và thử lại. Đối chiếu DB: current/lifetime giữ nguyên 3 và 7,
  **0 stamp events**. Chạy Owner/Admin Auth thật, không demo cookie.
- Chỉ bật cổng đọc Loyalty trong DB QA loopback và tenant synthetic; khôi phục
  platform flag sau từng fixture. Khóa thay đổi giá trị trong ứng dụng luôn OFF.
  Không Supabase hosted/Production, migration, provider, email/SMS hoặc thanh toán.
- Không phải nghiệm thu cộng/trừ điểm/đổi quà, PWA/offline, mọi lỗi truy vấn DB
  hoặc thống kê theo timezone. Lần manual từng thấy form tra cứu trở về trống
  khi Dashboard cập nhật; đã tái hiện và xử lý trong lượt theo dõi bên dưới.
  Đây là mất state giao diện, không phải mất điểm trong database.
- Server vẫn có stream-abort; phiên manual còn có refresh-token-not-found quanh
  tài khoản synthetic đã dọn. Không lọc log để gọi hệ thống hoàn toàn sạch.

Lệnh bổ sung:

```sh
node qa/day5/run-local.mjs test --config qa/day6/playwright.config.ts --project=se-vi --project=desktop-admin-en --grep 'configured loyalty'
node qa/day5/run-local.mjs test --config qa/day6/playwright.config.ts
npx --offline vitest run src/shared/loyalty/__tests__/valueMutationSafety.spec.ts src/shared/features/__tests__/loyaltyRolloutBoundary.spec.ts src/shared/dashboard/__tests__/clientSpendAuthorization.spec.ts src/shared/dashboard/__tests__/ownerPulseAttentionHref.spec.ts src/shared/dashboard/__tests__/serviceValueCents.spec.ts src/shared/dashboard/__tests__/receptionistDaySnapshot.spec.ts src/components/receptionist/__tests__/receptionistLocale.spec.ts
```

## Kết luận / bước kế tiếp

### Theo dõi bổ sung — giữ nội dung tra cứu khi Dashboard làm mới

- Đã tái hiện lỗi trên bản build trước sửa: Owner SE VI tra thẻ 3/10, bấm
  Làm mới; assertion số điện thoại thất bại vì input trở về chuỗi rỗng.
- Nguyên nhân: `SalonOwnerDashboardMain` đặt Loyalty bên trong nhánh thay thế
  bằng skeleton khi `isLoading/manualRefreshing`; polling 30 giây và refresh
  thủ công đều có thể unmount widget, mất state nhập/tra cứu.
- Sửa local tối thiểu: chỉ một widget ở vị trí ổn định ngoài nhánh skeleton,
  `key={slug}` để không giữ trạng thái khi chuyển salon. Không thay server
  action, quyền, đường ghi Loyalty hoặc chính sách điểm.
- Rà soát React phát hiện việc giữ mount cũng cần giữ nhịp tải số liệu: truyền
  mốc cập nhật Dashboard để đọc lại program/stats, tách cleanup lookup khỏi
  cleanup tải thống kê. Refresh số liệu không hủy request tra cứu đang chờ.
- Bản chỉ giữ mount đạt 30/30 nhưng kiểm tra thêm dữ liệu mới **FAIL**:
  đổi tên program synthetic rồi refresh vẫn hiện tên cũ. Đây là bằng chứng
  cần `refreshToken`, không dùng matrix xanh trước đó thay cho bản sửa cuối.
  Test bổ sung đổi tên trước refresh, khôi phục tên trước polling và đọc lại;
  chỉ sửa program của tenant fixture local, không điểm hoặc salon kinh doanh.
- Bổ sung hồi quy: refresh thủ công giữ số/thẻ; quan sát response polling thật
  (không tăng tốc đồng hồ), giữ số đang nhập dở và keyboard focus.
- Typecheck, ESLint hai file, build và 54 unit liên quan PASS. Focused SE VI
  và desktop Admin EN **2/2 PASS (1.1 phút)**, có chu kỳ polling thật.
- Computer Use trên build mới, Owner Auth synthetic, VI 320×568: tra thẻ 3/10,
  bấm nút Làm mới trong Owner Home, cuộn về widget; số và thẻ vẫn nguyên,
  cộng/trừ vẫn disabled. Tab đã đóng, viewport reset, fixture đã dọn.
- Không hứa giữ form qua browser reload/đóng tab/đăng xuất; không lưu phone
  vào localStorage. Parent vẫn loại bỏ nội dung khi kiểm tra quyền thất bại.
- Bản cuối có refresh dữ liệu: **30/30 UI/SSR PASS, 5.5 phút, retries=0**
  trên sáu cấu hình. Mỗi ca Loyalty chứng minh tên program mới đi vào UI qua
  refresh thủ công và tên khôi phục đi vào UI sau polling; current/lifetime
  vẫn 3/7, stamp events vẫn 0. Không mock đồng hồ hoặc response thành công.
- Computer Use lặp lại trên đúng build cuối ở VI 320×568: thẻ 7/10 và số
  điện thoại giữ nguyên sau Làm mới, hai nút ghi disabled. Đã dọn fixture,
  đóng tab và reset viewport. Đối chiếu DB cuối: salons/users/bookings/
  client_profiles/loyalty_cards/loyalty_programs/stamp_events đều 0;
  platform flag Loyalty trả về không có dòng như trước test.
- Typecheck → build tuần tự PASS; ESLint file sửa, diff check và 54/54 unit
  PASS trên bản cuối. Vẫn ghi nhận stream-abort trong matrix và refresh token
  không còn tồn tại từ phiên synthetic cũ trong manual; không tuyên bố log sạch.

**PASS phạm vi hồi quy local đã chạy; chưa đóng toàn bộ Ngày 6 hoặc Masterplan.**
Các điểm chưa kiểm, warning và hạn chế UI phía trên vẫn mở. Không có bằng chứng
Preview/Production hay người chủ mới dùng iPhone vật lý từ lượt này.

Batch local đã sẵn cho review; commit/push/PR/Preview chỉ làm sau khi được duyệt.
Sau Preview cần nghiệm thu V1-24 trên máy thật; không thay bằng số test xanh.

Rollback local: bỏ riêng các hunk Day 6 sau review hoặc revert commit Day 6 khi
đã có commit; giữ nguyên các hunk Day 5. Không reset cả worktree. Không có
migration, dữ liệu Production hay cấu hình provider để rollback trong lượt này.

### File thuộc Day 6

- `src/components/dashboard/{OwnerHomeDashboard,OwnerPulse,LoyaltyDashboardWidget,ClientProfilesPanel,ClientProfile360Drawer}.tsx`
- `src/components/receptionist/NotificationDeliveryRescueCard.tsx` (chỉ prefetch)
- Lượt bổ sung: `DateSwitcher.tsx`, hunk khởi tạo/reconcile `dateOffset` của
  `ReceptionistCenter.tsx`, helper/test `receptionistDaySnapshot`, test
  `receptionistLocale` và chuỗi `dateSwitcher.day` trong EN/VI. Giữ các hunk ngày 5.
- `src/shared/dashboard/{loadOwnerHomeDashboardAction,loadOwnerPulse,loadClientProfile360Action,serviceValueCents,ownerPulseAttentionHref}.ts`
- `src/shared/dashboard/__tests__/{serviceValueCents,ownerPulseAttentionHref,clientSpendAuthorization}.spec.ts`
- `qa/day6/{playwright.config.ts,owner-journey.spec.ts,client-directory.spec.ts}`
- Lượt Loyalty: `src/components/loyalty/StampCard.tsx`, hunk mới của widget
  dashboard; `qa/day6/{loyalty-fixture.ts,loyalty-readonly.spec.ts}`. Server action,
  runtime gate, schema và permissions giữ nguyên.
- Theo dõi refresh: `src/components/dashboard/SalonOwnerDashboardMain.tsx`
  giữ vị trí widget ổn định; bổ sung assertions vào spec Loyalty ở trên.
- `qa/day5/{run-local.mjs,manual-fixture.ts}` (thêm mode Owner, giữ receptionist)
- Báo cáo này, handoff ngày 6 và `MASTERPLAN_ACCEPTANCE_CURRENT.md`.

Phần còn lại trong dirty worktree là thay đổi ngày 5 đã có trước; không tự
coi toàn bộ `git diff` là phạm vi Day 6.
