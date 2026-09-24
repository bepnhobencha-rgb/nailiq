# Ngày 7 tiếp nối — Mời lại Waitlist và lỗi mạng

Ngày: 24/09/2026 (Vancouver). Liên quan P1-01/V1-22/V1-23, Giai đoạn 4
Master Plan. Không đổi roadmap hoặc tự ký nghiệm thu toàn bộ một ngày.

## Kết luận

**PASS local cho chống bấm lặp, phục hồi lỗi và không báo thành công giả.**
**PASS LOCAL cho lỗi phản hồi ngoài màn hình sau hotfix:** trước sửa, thông báo
lỗi ở cuối danh sách và tự mất sau 4 giây. Đã tái hiện FAIL bằng viewport assertion,
sửa vị trí hiển thị và chạy lại cả matrix PASS (chi tiết bên dưới).
Không có bằng chứng provider/Production mới. Không đóng P1-01 toàn bộ.

## Mốc kiểm chứng

- Worktree `/private/tmp/nailiq-day5-receptionist-20260924`.
- Branch `qa/day5-receptionist-20260924`, HEAD
  `6ddf8f2fcaff4d4ea8b45d3580ecc6c1a3a6612d`.
- GitHub read-only: PR #1424 OPEN, Ready, CLEAN; 20 SUCCESS, 2 SKIPPED.
  Đây là CI của HEAD, không phải CI của các tests chưa commit trong đợt này.
- Runtime local thay đổi duy nhất `OnlineWaitlistPanel.tsx` ở lớp hiển thị feedback.
  Không thay database, migrations, sender, consent hoặc cấu hình Production.

## Test mới

`qa/waitlist-delivery/tests/invite-recovery.spec.ts` dùng panel thật và transport
Server Action thật ở phía browser; mọi action POST bị chặn trước server.
3 trạng thái (waiting, failed/opt-out, unknown/sending) × 2 lỗi (network, HTTP503)
× 2 ngôn ngữ × 2 browser profiles = **24 ca mới**.

Mỗi ca kiểm: double-click; click khách khác khi đang pending; chỉ một request;
hiện lỗi; nút mở lại; giữ trạng thái/delivery; chủ động retry được đúng một
request nữa; không request bên ngoài, không forwarding mutation, không pageerror.
Không suy ra idempotency server từ kiểm tra client này.

Lượt đầu: **28/28 PASS, 0 retry**, 34.1 giây nhưng chỉ kiểm DOM visible. Computer
Use phát hiện thiếu kiểm viewport. Thêm `toBeInViewport({ ratio: 1 })` rồi chạy
ca Chromium EN/failed/503 trước sửa: **FAIL, viewport ratio 0**; toast tự mất trong
thời gian assertion chờ. Sau hotfix và build lại fixture: **28/28 PASS, 0 retry,
35.1 giây**. Cả 24 ca recovery có viewport assertion và attachment
`feedback-viewport-audit`; không bỏ hoặc nới điều kiện để lấy PASS.

Backend mock: bổ sung 7 tests vào
`src/shared/noshow/__tests__/deliverPromotedWaitlistOffer.spec.ts`:

- recipient null/rỗng/whitespace: không claim hoặc gọi sender;
- email opt-out qua retry: suppressed, không provider receipt, không gọi email;
- claim không cấp lease mới: không gọi sender, không tự hoàn tất.

File unit: **23/23 PASS**, trong đó 7 mới. Chạy thêm ba file boundary/capacity:
**40/40 PASS trong 4 files**. Client Supabase/RPC và sender đều là mock; không
phải kiểm chứng DB/provider runtime.

## Computer Use — lỗi phản hồi ngoài màn hình

1. Mở bản local qua proxy chỉ chuyển GET/HEAD tới fixture; mọi mutation được
   trả HTTP503 sau 1.5 giây, không chuyển tới Next Server Action.
2. Chọn khách QA Failed ở giữa danh sách; bấm Invite again.
3. Nút tạm khóa rồi mở lại. SMS vẫn Failed, email vẫn Customer opted out.
4. DOM có `Could not send the invite. Please try again.` nhưng hình học thật:
   top=2668.78, bottom=2702.43, viewportHeight=753, intersectsViewport=false.
5. Screenshot vẫn ở khách đang thao tác, không thấy lỗi bên dưới. Toast tự mất
   sau 4 giây; lần đọc đầu đã bỏ lỡ, lượt sau đọc trong cùng thao tác đã xác minh.

**Mức độ: trung bình, chặn nghiệm thu UX retry.** Tiếp tân có thể hiểu nhầm
không có phản hồi và bấm lại. Không có chứng cứ gửi trùng từ lỗi bố cục này.
Nguyên nhân code: `OnlineWaitlistPanel.tsx` render `waitlist-toast` sau toàn bộ
danh sách dưới dạng output trong normal flow, dùng timer 4000ms.

Lượt manual dùng EN. Ban đầu URL fixture `?lang=vi` nhưng panel dùng preference
EN của browser; không tính manual là PASS VI. Matrix tự động EN/VI đặt language
storage rõ ràng và đã PASS. Không gán hành vi fixture này cho Production.

Proxy ghi **3 mutation bị chặn, 0 được chuyển tiếp**. Tab riêng đã đóng, hai
local listeners đã dừng. Không chạm tab Firewall của Huy hoặc hosted iPhone fixture.

## Hotfix và kiểm chứng lại bằng Computer Use

- Giữ output/live-region hiện có, đưa ra ngoài scroll/transform container bằng
  portal; ghim vào viewport với khoảng cách safe-area và lớp toast theo design
  system. Nền đặc để chữ không lẫn vào lịch bên dưới. Không thêm primitive mới.
- Không giật focus hoặc cuộn danh sách, không chặn thao tác phía dưới. Giữ nguyên
  bản dịch, timer 4 giây, pending guard và kết quả delivery do server trả về.
- Computer Use bấm QA Failed → Invite again trên bản vừa build qua proxy chỉ đọc:
  thông báo lỗi **top=16, bottom=62, viewportHeight=720, fullyVisible=true**.
  Screenshot xác nhận nhìn thấy rõ ở góc trên, cùng khách đang thao tác.
- SMS vẫn Failed, email vẫn Customer opted out. Lượt sau sửa ghi **1 mutation bị
  chặn, 0 chuyển tiếp**. Tab/proxy/Next listeners riêng đã đóng/dừng.
- Đây là kiểm chứng EN trực tiếp và EN/VI desktop/WebKit tự động; không thay thế
  iPhone vật lý, thiết bị trợ năng hoặc luồng authenticated hosted.

## Lệnh và kết quả

Các lệnh browser/build chạy trong môi trường đã lọc, không credentials, bật
kill-switch và route guard chặn external/mutation.

```sh
node node_modules/next/dist/bin/next build qa/waitlist-delivery --webpack
node node_modules/@playwright/test/cli.js test --config qa/waitlist-delivery/playwright.config.ts
./node_modules/.bin/vitest run src/shared/noshow/__tests__/deliverPromotedWaitlistOffer.spec.ts
./node_modules/.bin/vitest run src/shared/noshow/__tests__/deliverPromotedWaitlistOffer.spec.ts src/shared/security/__tests__/falseWaitlistAndDetailsBoundary.spec.ts src/shared/booking/__tests__/smartCapacityRescueAcceptance.spec.ts src/shared/booking/__tests__/capacityRescueAutonomy.spec.ts
./node_modules/.bin/eslint src/components/receptionist/OnlineWaitlistPanel.tsx src/shared/noshow/__tests__/deliverPromotedWaitlistOffer.spec.ts qa/waitlist-delivery/tests/invite-recovery.spec.ts
npm run typecheck
./node_modules/.bin/tsc --noEmit --project qa/waitlist-delivery/tsconfig.json
node node_modules/next/dist/bin/next build --webpack
git diff --check
```

Build fixture, root/fixture typecheck và lint PASS sau sửa. Full root build
**PASS** (compile 21.9s, TypeScript 4.4s, 61/61 static pages), chạy riêng sau
typecheck trong env không credentials, không có `.env` local. Còn warning Edge
Runtime deprecated và không static generation cho edge page; không che giấu warning
hoặc đổi cấu hình ngoài phạm vi. Lần khởi động đầu bị sandbox từ chối listen
localhost (EPERM), chạy lại với quyền local đã được xét duyệt thì được. Lần test
đầu sai so sánh `innerText` với `textContent` (khác xuống dòng); sửa test rồi
rerun PASS, không phải bug sản phẩm. Một lệnh tái hiện dùng nhầm tên project
`chromium-desktop` bị từ chối trước khi chạy; sửa về `chromium` đúng config rồi
tái hiện FAIL thật. Không bỏ test hoặc retry để che lỗi. Vitest có cảnh báo
configLoader CommonJS/ESM của cấu hình hiện hữu; không phải test failure.

## Phần tiếp theo

- Điểm hiển thị feedback đã sửa và kiểm local; chưa phát hành. Rollback local
  chỉ cần bỏ hunk portal/positioning của panel, không thay data hoặc sender.
- Không mở rộng thành redesign Waitlist hoặc thay chính sách gửi/consent.
- Provider terminal delivery, hosted authenticated invite/claim và người dùng
  thật vẫn NOT PROVEN; không dùng kết quả mock thay nghiệm thu đó.
- Không commit, push, merge, deploy, migration, gửi thông báo hoặc gọi provider.

## Phê duyệt xuất bản — 24/09/2026

Huy đã yêu cầu `commit/push/deploy` sau báo cáo local. Phạm vi triển khai được
thông báo là Preview của PR #1424, không merge/Production. Các câu chưa xuất bản
bên trên là checkpoint trước phê duyệt, không phải trạng thái phát hành mới.

Preflight read-only trước xuất bản: đúng project `nailiq`, nhánh
`qa/day5-receptionist-20260924`; cả hai URL Supabase trỏ QA
`uhpzafoiifupyypkcwln`; SMS/email/call disable=1; payment workers và sandbox
webhook ingestion=false; 13 biến credential provider được kiểm tra đều trống.
Không lưu giá trị bí mật. Không thay env hoặc WAF. Production vẫn
`dpl_FX3WJBMueRCword7mwJyyhafPNPc` ở thời điểm preflight.

Chỉ đưa panel, test recovery, test backend mock và báo cáo này vào commit;
không gom các tài liệu/runner Day5–7 còn dang dở khác. CI/Preview của commit
mới cần kiểm riêng; không dùng CI xanh của HEAD cũ để kết luận đã triển khai.
