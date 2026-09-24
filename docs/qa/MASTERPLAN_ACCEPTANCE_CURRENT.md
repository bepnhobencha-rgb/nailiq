# NailIQ — Bảng nghiệm thu Masterplan

Cập nhật bằng chứng Auth, Receptionist và Owner/Admin QA: 24/09/2026 (Vancouver); các mốc Production dưới
đây vẫn là snapshot 22/09, không phải lần kiểm chứng Production mới.
Đây là bảng theo dõi nghiệm thu hiện hành; không thay đổi
phạm vi, chính sách hay điều kiện đạt trong `docs/MASTER_PLAN.md`.

**Kết luận: chưa đủ bằng chứng nghiệm thu toàn bộ Masterplan.** Không quy đổi
số test xanh thành phần trăm chức năng hoàn thành. Thiếu bằng chứng không đồng
nghĩa đã xác nhận có lỗi.

## 1. Mốc và cách đọc

- [Batch review Ngày 5–6](day5-day6-review-batch-2026-09-24.md): full unit
  6.658 PASS / 65 skipped ở cổng trước commit; chưa Preview/Production.
  Chặn auto-deploy nhánh mới đến khi cấu hình QA riêng được xác minh.
- Ngày 6: [Owner/Admin local QA](masterplan-day-6-owner-2026-09-24.md).
  Sửa cảnh báo ngày mai, giá dịch vụ phụ trong Pulse/hồ sơ khách, chú thích
  nguồn số tiền, EN/VI và prefetch link phụ. Bổ sung sửa tab ngày trước hydration,
  KPI ngày/tên khách dài trên điện thoại. Lượt bổ sung sửa nút phân trang bị Coco
  che, race tìm kiếm/phân trang và thông báo không có kết quả/thử lại khi lỗi.
  Thêm tra cứu Loyalty read-only, khóa nút cộng/trừ theo server, xóa thẻ cũ
  khi đổi số và phục hồi lỗi mạng. Sửa mất form khi Dashboard refresh/polling;
  giữ số/con trỏ nhưng vẫn tải program/stats mới, không đổi khóa ghi điểm.
  Matrix cuối 30/30 real-Auth Owner/Admin
  UI/SSR PASS, không retry; 54/54 unit liên quan PASS (284 unit là lượt trước).
  Computer Use 320px kiểm ba trang của 52 khách giả và thẻ tích điểm synthetic.
  Chưa commit/push/Preview/Production; không chứng minh V1-24 iPhone vật lý.
- Ngày 5: [Receptionist local QA](masterplan-day-5-receptionist-2026-09-24.md)
  trên nhánh `qa/day5-receptionist-20260924`, base `f6bf087b9d6f4354c3742ee270ab6aaf78cc8d9d`.
  208 unit tests, 6 UI journeys desktop/iPhone/iPad EN/VI với Auth receptionist
  thật, 9 tenant/role và 6 race/retry PASS. Computer Use xác minh focus,
  busy/free, tiếng Việt và giữ ngày sau refresh/reload. Chưa commit/push/Preview
  hoặc deploy; không bằng chứng Production mới. Nghiệm thu tiếp tân mới thật
  theo V1-21 chưa chạy; [phiếu nghiệm thu](day5-human-acceptance-sheet.md) để riêng.
- Ngày 4: [gói Auth/Owner QA](day4-auth-session-closeout-2026-09-23.md)
  đã PASS trong phạm vi được ghi: branded magic-link vào Inbox iCloud,
  callback tạo phiên Owner, reload giữ phiên và cleanup đúng salon synthetic.
  Hotfix thuộc Draft PR #1422, chưa merge/deploy Production. Preview SHA
  `f58ae9f6b484f799adee11cda4b7a27822247e0c`: 22 checks SUCCESS, 2 SKIPPED.
  Lần mở thư bằng Safari cần chuyển callback về phiên Chrome ban đầu; không
  tính là trải nghiệm tự động xuyên trình duyệt. Signup từng vào Junk vẫn
  được giữ là FAIL mẫu lịch sử, không thay bằng kết quả magic-link mới.
  Kết quả này không đóng P1-01 thông báo booking/waitlist hoặc toàn Masterplan.
- `origin/main`: `7e19ae1316e493925aafec0f32cf1acb1e68599d`, đã fetch ngày 22/09.
  Đây là merge SHA của PR #1420; không được suy từ `main` rằng mọi acceptance
  bên dưới đã được kiểm lại trên Production.
- PR #1420 đã merge và được deploy thủ công từ clean detached worktree đúng
  merge SHA; deployment `dpl_CeYSH44TZug6G55Bfmd1owX5JH3Z` ở trạng thái
  READY và được alias tới `www.nailiq.ca`. Sau deploy, `/api/health` và
  `/api/ready` PASS; hai trang `/hilite-anaheim` và `/hilite-studio` HTTP 200.
  Không có migration, provider call hoặc thông báo trong rollout này.
- PR #1417 đã merge lúc `2026-09-22T01:15:54Z`. Vì Vercel project đang ở chế
  độ `sourceless`, Git integration không tự tạo deployment cho merge này.
  Production đã được deploy thủ công từ clean detached worktree đúng merge SHA;
  deployment `dpl_AKUpBoxBUQU4Hdcmd8TAVuMRRfJM` READY trước #1420.
- Health/readiness và HTTP probes chỉ chứng minh các kiểm tra được endpoint thực hiện; không
  chứng minh mọi migration/ACL, mọi salon hay mọi hành trình khách hàng đều đúng.
- P1-06: [PR #1413](https://github.com/bepnhobencha-rgb/nailiq/pull/1413) đã
  MERGED và triển khai Production thủ công. Ứng viên cuối trước merge là
  `92783d03948d9569f1140791c37529b19acd8dd9`; merge SHA là
  `ae406a2419f924a6c0a1b209a61f018a1af6a04a`.
- Ba suite release/offboarding chạy local: **20/20 PASS**. CI cuối trên ứng viên
  đã PASS build/typecheck, security, smoke, visual, i18n, Vercel Preview và toàn
  bộ E2E bắt buộc, gồm Receptionist Center desktop/mobile, non-RC, recovery thật
  và tenant-role/session revocation. Các job `MQA-0148 source` và `AI Triage`
  SKIPPED theo workflow, không được tính là PASS.
- Không chạy provider hoặc gửi thông báo trong rollout #1413. Không có migration
  thuộc PR #1413.
- P0-03: [PR #1417](https://github.com/bepnhobencha-rgb/nailiq/pull/1417) đã
  MERGED. Supabase Production đã áp đúng migration
  `20260921170000_harden_public_booking_resource_catalog_invoker.sql`; migration
  parity `20260908014241` đã tồn tại từ trước và không bị áp lại. Metadata, exact
  function signatures, ACL và Security Advisor đều được kiểm chứng; Advisor hiện
  **0 ERROR, 20 WARN**. Bằng chứng rollout #1417 được ghi riêng trong tài liệu
  P0-03 bên dưới.
- CI và E2E hậu-merge của SHA `7c5fad5` đều SUCCESS. E2E gồm i18n/copy, smoke,
  visual, tenant-role/session revocation real-auth, settings/SuperAdmin recovery,
  non-RC và Receptionist Center desktop/mobile. Hai job có điều kiện `MQA-0148`
  và `AI Triage` SKIPPED, không được tính là PASS.
- Rollout #1417 không gọi provider, không tạo booking và không gửi thông báo.
- Bảng 30 tiêu chí V1 ngày 11/09 là nguồn ID/điều kiện. Các nhãn “chưa merge”
  trong báo cáo lịch sử được đối chiếu lại bằng Git/GitHub; không sửa lại lịch sử.
- `PASS QA`: đạt phạm vi QA đã nêu. `DEPLOYED`: code đã nằm trong SHA Live.
  `NOT PROVEN`: chưa đủ chứng cứ điều kiện đạt. `BLOCKED`: cần quyết định,
  quyền thao tác hoặc người tham gia thực tế. Không đồng nhất các nhãn này.

## 2. Bảy giai đoạn Masterplan

| Giai đoạn | Bằng chứng có thể xác nhận | Điều kiện còn thiếu để đóng |
|---|---|---|
| 1. Môi trường và đăng ký | Day 2 salon trắng và Day 3 Google OAuth thật đã PASS hosted QA trên Preview branch-scoped; private/off defaults, trial 14 ngày, callback recovery, chống user/salon trùng và cleanup đã được đọc lại từ QA | Chưa phải Production/pilot proof; clean-browser/device return-login và owner mới thực tế vẫn là bằng chứng nâng cao |
| 2. Tiếp tân | Năm việc cốt lõi đã có QA desktop/WebKit; sửa UX nằm trong PR #1409 đã merge | Người mới tạo hẹn dưới 60 giây và walk-in dưới 30 giây; xác nhận chế độ thường/cao điểm với người dùng |
| 3. Admin iPhone | QA profile iPhone SE/Pro Max/iPad có bằng chứng | Dùng một tay trên iPhone vật lý và hoàn tất năm việc Admin |
| 4. Ổn định | Các sửa P0/P1 #1401, #1404–#1411 và phòng ngừa sự cố #1413 đã vào main; probe Live sau rollout PASS | Đóng từng acceptance còn mở; đủ bằng chứng thông báo/provider và diễn tập vận hành pilot |
| 5. Pilot | Hai salon Live là bối cảnh vận hành, không thay biên bản pilot | Ba salon, thành phần người dùng đúng yêu cầu, 7–14 ngày, số đo và kết luận |
| 6. Trial/thanh toán | PR #1411 triển khai trial 14 ngày + 7 ngày continuity + read-only; activation V1 thủ công theo báo cáo đã duyệt | Masterplan còn yêu cầu tự thanh toán: cần xác nhận phạm vi nghiệm thu V1 thủ công hoặc xây/chứng nhận riêng self-pay; không tự đổi chính sách |
| 7. Bán có kiểm soát | Chưa tìm thấy bằng chứng đủ trong bộ hồ sơ được kiểm tra | Cohort 10 salon, funnel 30 ngày, hỗ trợ và tỷ lệ chuyển đổi có dữ liệu |

## 3. Ma trận 30 tiêu chí V1

Các PASS lịch sử chỉ có giá trị trong phạm vi đã thử, không phải rerun trên SHA
ngày 20/09. Nguồn viết tắt được giải thích ở mục 6.

| ID | Tiêu chí | Trạng thái/bằng chứng | Việc cần đóng tiếp theo |
|---|---|---|---|
| V1-01 | Bản phát hành/code/schema | PASS rollout #1417 trong phạm vi migration P0-03: exact migration đã dry-run/apply, metadata/ACL/Advisor PASS; #1420 đã manual deploy READY và health/readiness PASS | Mỗi release có migration tiếp theo vẫn phải rehearsal/audit riêng; Vercel project `sourceless` nên cần giữ bằng chứng clean worktree → deployment |
| V1-02 | Trang salon | `/hilite-anaheim` và `/hilite-studio` HTTP 200 sau rollout #1417 và #1420 | Read-only UI smoke toàn bộ danh sách salon phát hành vẫn là gate riêng |
| V1-03 | Đăng ký salon mới | PASS HOSTED QA: email/synthetic salon và Google OAuth thật đã tạo đúng một private salon; 14-day trial, defaults, membership và cleanup được đọc lại | Chưa phải Production/pilot proof; owner thật và clean-browser/device return-login nếu cần mức bằng chứng cao hơn |
| V1-04 | Đăng nhập/khôi phục | PASS QA lịch sử; CI hậu-merge #1417 settings/SuperAdmin recovery xanh; Day 2/3 callback recovery QA PASS | Production/pilot owner mới vẫn là cổng riêng |
| V1-05 | Cookie bảo mật | PASS QA lịch sử; code nằm trong main | Giữ regression trên ứng viên phát hành, không tính cookie lịch sử là kiểm tra phiên hiện tại |
| V1-06 | MFA SuperAdmin | PASS QA; CI hậu-merge #1417 SuperAdmin recovery xanh | Quét QR/Authenticator trên máy thật nếu đưa vào ký nghiệm thu vật lý |
| V1-07 | Cấu hình salon | P1-04 PASS QA, PR #1410 đã deploy | Owner từng salon xác nhận catalog/giờ/thợ/resource |
| V1-08 | Tenant/role | PASS trong phạm vi tự động hiện hành: CI hậu-merge #1417 tenant roles/session revocation SUCCESS; Production metadata read-only có 241/241 public tables bật RLS | Giữ regression trên mỗi release có thay đổi auth/ACL; pilot người thật vẫn là bằng chứng riêng |
| V1-09 | Chống lạm dụng | Production DB closure PASS: migration P0-03 đã áp, view dùng `security_invoker`, helper/snapshot có exact ACL và Advisor 0 ERROR/20 WARN. Durable quota và tenant QA PASS. Hai WAF SDK rules vẫn active/valid ở log-only, không có pending draft | Quan sát đủ log-only để đánh giá false positive trước mọi đề xuất enforce; pilot/traffic thực vẫn NOT PROVEN |
| V1-10 | Booking cá nhân | PASS Live lịch sử Studio; P1-04 QA | Nghiệm thu đúng cấu hình từng salon pilot |
| V1-11 | Giờ/resource | P1-04 unit/browser PASS | Owner xác nhận shift/capability/giường và rehearsal từng salon |
| V1-12 | Booking nhóm | #1401 và #1404 đã deploy; lỗi dependency/failure recovery có regression | Phân loại incident 503 lịch sử và chứng cứ runtime; không yêu cầu mọi 503 phải biến mất |
| V1-13 | Idempotency | P1-04 race/response-loss QA PASS | Ghép receipt/race đúng cấu hình pilot vào biên bản |
| V1-14 | Đổi/hủy lịch | P1-03 QA PASS; #1409 đã deploy | Rehearsal pilot + receipt sau reload/xung đột |
| V1-15 | OTP | Có PASS Live lịch sử và QA guard | P1-01: recipient/callback/retry đúng môi trường và phạm vi được phép |
| V1-16 | Lưu thẻ thật | Studio Live lịch sử; Head Spa synthetic Sandbox PASS | Không suy ra toàn bộ lịch cũ đã được bảo vệ; Owner xử lý exception |
| V1-17 | Thẻ bị từ chối/receipt sai | R11/P1-02 QA/Sandbox PASS | Giữ các ca fail-closed trong release candidate |
| V1-18 | Mất response lưu thẻ | R11/P1-02 Sandbox race/reconcile PASS | Không phát lại CreateCard khi unknown; kiểm tra candidate khi đường này thay đổi |
| V1-19 | Recovery/exception | #1408 đã deploy; Owner QA Preview PASS | Rà soát exception hiện tại với Owner; số liệu 14/09 không coi là số hiện tại |
| V1-20 | Không thu nhầm | PASS lịch sử; QA thiếu receipt không chargeable | Nghiệm thu thu tiền là phạm vi riêng, không suy từ lưu thẻ |
| V1-21 | Năm việc tiếp tân | Ngày 5 local: 6 real-Auth UI journeys EN/VI và 15 tenant/race/retry PASS; Computer Use bổ sung. Bản sửa chưa phát hành | Người mới thật tạo hẹn/walk-in mỗi việc dưới 60 giây, không hướng dẫn; ghi đủ năm việc, không dùng thời gian robot thay người |
| V1-22 | Queue/waitlist | P1-01/P1-03 synthetic UI PASS; #1406/#1407 đã deploy | Offer/claim đúng khách và terminal provider delivery có chứng cứ |
| V1-23 | Thông báo/reminder | P1-01 delivery truth đã deploy; synthetic callback PASS | Provider QA terminal delivery chưa hoàn tất trong hồ sơ; acceptance 24h/3h và opt-out |
| V1-24 | Admin một tay | Day 6: 30/30 local real-Auth UI/SSR PASS; Computer Use 320px, 52 khách/3 trang, Loyalty read-only | Năm việc trên iPhone vật lý và chủ mới chưa proven; bản sửa chưa phát hành |
| V1-25 | EN/VI và thiết bị | Ngày 5 local: sáu device/language profiles PASS (Chromium desktop, WebKit iPhone/iPad × EN/VI); chưa Preview/Production | Profiles không phải phần cứng thật; hoàn tất matrix vật lý theo phạm vi phát hành |
| V1-26 | Incident và recovery | P1-06 drill/restore có bằng chứng; #1413 đã merge/deploy; CI và post-deploy verification PASS | Ghi người trực và thực hiện rehearsal vận hành trong pilot; rollout kỹ thuật không thay thế chứng cứ con người |
| V1-27 | Restore/offboarding | P1-06 PostgreSQL rehearsal lịch sử PASS | Gắn thời gian phục hồi, người phụ trách và recovery acceptance vào biên bản |
| V1-28 | Trial/giá/thanh toán | #1411 đã deploy; QA expiry/manual billing PASS | Chốt khác biệt self-pay Masterplan và activation thủ công V1; Preview Auth hạn chế còn được ghi nhận |
| V1-29 | AI brief nếu nằm trong V1 | NOT PROVEN riêng cho pilot | Chốt scope pilot; nếu bật phải kiểm nguồn và các hành động có rủi ro |
| V1-30 | Pilot/mở rộng | NOT PROVEN | Ba salon 7–14 ngày và KPI trước cohort 10 salon |

## 4. Hàng đợi đóng điểm chặn

| Mã | Bản sửa/QA đã có | Phần còn mở | Người thực hiện/bước kế tiếp |
|---|---|---|---|
| P0-01 | #1401 merged 11/09; #1404 merged 14/09; regression và diagnostics | Chưa chứng minh nguyên nhân từng 503 lịch sử; không tự tạo lỗi trên Live | Kỹ thuật: ghép log có request/stage/SHA nếu còn; ghi rõ giới hạn lịch sử |
| P0-02 | Đã PASS hosted QA: Preview branch-scoped dùng QA disposable, Google provider QA riêng, salon trắng/email synthetic, Google OAuth thật, callback recovery, chống trùng, private/off defaults và cleanup đều có evidence; local 12 browser + 69 contract/unit và build PASS | Không còn điểm chặn kỹ thuật Day 2/Day 3 ở mức QA; còn clean-browser/device return-login, UX logout trong Guided Setup và pilot owner thật | Đóng P0-02 ở mức QA. Chuyển UX logout/progress sang backlog và giữ Production/pilot là cổng riêng |
| P0-03 | PR #1417 merged; migration `20260921170000` đã áp Production; metadata/function signatures/ACL/Advisor PASS với 0 ERROR/20 WARN; deployment READY; hậu-merge CI/E2E SUCCESS; WAF version 9 có `booking-page-load` 60/60s/IP và `contact-submit` 5/3600s/IP, vượt ngưỡng chỉ log | Database/ACL đã đóng. WAF cần thời gian quan sát false positive; chưa có bằng chứng enforce hay traffic/pilot thực | Kỹ thuật: giữ log-only, thu thập số liệu và chỉ đề xuất enforce bằng thay đổi riêng có rollback; không mở thêm migration cho lỗi đã đóng |
| P1-01 | #1406/#1407 merged; synthetic delivery truth PASS | Provider delivery/callback acceptance | QA: chuẩn bị người nhận/case cụ thể trước một lượt provider được phép |
| P1-02 | #1408 merged; Sandbox/backend/browser PASS | Live exception recovery cần Owner; dữ liệu cũ không đại diện hôm nay | Owner + QA: duyệt từng trường hợp sau snapshot read-only mới |
| P1-03 | #1409 merged; profile EN/VI PASS | Người mới, thời gian, máy thật | QA/pilot: ghi từng nhiệm vụ, số trợ giúp và kết quả |
| P1-04 | #1410 merged; 60 browser PASS, 3 SKIP; 32 unit PASS theo báo cáo | Attestation đúng cấu hình từng salon | Owner + QA: xác nhận cấu hình và rehearsal không dùng khách thật |
| P1-05 | #1411 merged; giá/trial/manual activation đã có QA | Scope self-pay khác Masterplan; authenticated Preview chưa proven | Huy chốt phạm vi thương mại; kỹ thuật giữ nguyên chính sách đã triển khai |
| P1-06 | #1413 merged; CI cuối xanh; 20 tests local PASS; manual Production deployment READY; health/readiness và hai trang Hi-Lite PASS | Phần kỹ thuật release prevention đã Live; chưa có bằng chứng người trực/rehearsal pilot | Đóng phần kỹ thuật. Chuyển phần con người sang checklist pilot, không mở thêm hotfix nếu không có lỗi mới |
| P1-07 | Chưa thấy bộ đo đủ điều kiện | Ba salon/7–14 ngày/thành phần người dùng/KPI | Huy + pilot owners: xác định salon thứ ba và người tham gia |

Không mở nhánh hoặc PR trùng cho những thay đổi đã merge. Không sửa sản phẩm
chỉ vì một báo cáo lịch sử chưa cập nhật trạng thái.

## 5. Checklist bàn giao pilot và điều kiện dừng

Mỗi salon cần một dòng: tên/slug, Owner xác nhận, ngày bắt đầu/kết thúc,
build SHA, catalog/hours/timezone/staff/resources đã xác nhận, người tham gia
(mã định danh nội bộ), thiết bị, ngôn ngữ và phạm vi tính năng.

Mỗi lượt người mới cần ghi: nhiệm vụ, bắt đầu/kết thúc, thành công/thất bại,
số lần hỗ trợ, chỗ do dự, lỗi phát sinh và evidence. Không lưu thông tin khách
thật vào báo cáo QA. Người lớn tuổi và tiếp tân ít dùng công nghệ phải được
đại diện đúng yêu cầu Masterplan.

- Ít nhất 80% tự hoàn thành năm việc cốt lõi.
- Tạo hẹn dưới 60 giây; walk-in dưới 30 giây.
- Không quá một lần trợ giúp trong ca đầu.
- Không mất dữ liệu; ít nhất hai trong ba salon muốn tiếp tục.
- Dừng mở rộng nếu có sai tenant/quyền, mất dữ liệu, double-book hoặc thu tiền sai.
- Synthetic/automation không thay cho người mới; không thể tạo 7–14 ngày quan sát
  bằng một lượt test nhanh.

## 6. Nguồn và lệnh xác minh

- Roadmap: [Master Plan](../MASTER_PLAN.md).
- P0-01: [group 503](P0_GROUP_503_2026-09-11.md).
- R11: [booking/card candidate](r11-combined-candidate-sandbox-2026-09-13.md).
- [P1-01](p1-01-notification-delivery-truth-2026-09-14.md),
  [P1-02](p1-02-head-spa-card-protection-2026-09-14.md),
  [P1-03](p1-03-v1-ux-device-matrix-2026-09-15.md),
  [P1-04](P1-04-SALON-BOOKING-TRUTH-2026-09-15.md),
  [P1-05](P1-05-TRIAL-PRICING-AUDIT-2026-09-15.md),
  [P1-06](p1-06-incident-restore-support-2026-09-16.md).
- [P0-03 tenant/role + quota/WAF runtime](p0-03-tenant-role-quota-waf-runtime-2026-09-21.md).
- [Masterplan Ngày 2 — đăng ký salon mới](masterplan-day-2-registration-2026-09-22.md).
- [Masterplan Ngày 3 — Google signup](masterplan-day-3-google-signup-2026-09-22.md).
- [Ngày 4 — Auth/Owner QA closeout](day4-auth-session-closeout-2026-09-23.md).
- Nguồn 30 ID: bản local lịch sử
  `/Users/huytran/nailiq-v1-acceptance-20260911/docs/qa/V1_ACCEPTANCE_2026-09-11.md`;
  không coi file local này là tài liệu đã merge.

Lệnh đã chạy trong đợt này:

```sh
git fetch origin main
gh pr list --state merged --limit 20 --json number,title,mergedAt,mergeCommit
gh pr view 1413 --json state,headRefOid,mergeable,statusCheckRollup,url,body
gh pr merge 1413 --merge
npx vercel --prod --yes
npx vercel inspect nailiq-21m7ll6xv-bepnhobencha-2588s-projects.vercel.app
node scripts/monitor-production-health.mjs --base-url https://www.nailiq.ca --allow-production-read-only
./node_modules/.bin/vitest run src/shared/security/__tests__/productionReleaseBoundary.spec.ts src/shared/security/__tests__/staffOffboardingBoundary.spec.ts src/shared/security/__tests__/staffOffboardingDurableNotificationBoundary.spec.ts
```

Rollout #1413 được thực hiện theo phê duyệt riêng: merge và manual Production
deploy, không migration, provider send, booking mới hoặc thay đổi dữ liệu salon.
Bảng này cần tiếp tục cập nhật theo evidence mới; không tự chuyển NOT PROVEN
thành PASS khi thời gian trôi qua.
