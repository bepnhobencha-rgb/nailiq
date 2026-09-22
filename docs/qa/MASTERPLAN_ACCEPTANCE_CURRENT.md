# NailIQ — Bảng nghiệm thu Masterplan

Cập nhật: 22/09/2026. Đây là bảng theo dõi nghiệm thu hiện hành; không thay đổi
phạm vi, chính sách hay điều kiện đạt trong `docs/MASTER_PLAN.md`.

**Kết luận: chưa đủ bằng chứng nghiệm thu toàn bộ Masterplan.** Không quy đổi
số test xanh thành phần trăm chức năng hoàn thành. Thiếu bằng chứng không đồng
nghĩa đã xác nhận có lỗi.

## 1. Mốc và cách đọc

- `origin/main`: `a78950cd9f9b4d9106eda81df10dbb00d3731d41`, đã fetch ngày 22/09.
  Đây là merge SHA của PR #1419; không được suy từ `main` rằng mọi acceptance
  bên dưới đã được kiểm lại trên Production.
- PR #1413 đã merge lúc `2026-09-21T15:00:00Z`. Production được deploy thủ
  công từ clean detached worktree đúng merge SHA trên; deployment
  `dpl_H7Tg9nPPvo6deeGDfQ7Xa5jcEM6n` ở trạng thái READY và được alias tới
  `www.nailiq.ca`.
- Kiểm tra trực tiếp sau deploy: `/api/health` trả `ok`; `/api/ready` trả
  `ready`, `database_schema=ok`, `cron_authorization=ok`; hai trang
  `/hilite-anaheim` và `/hilite-studio` đều HTTP 200. `/api/version` trả
  deployment ID của manual deploy, không trả Git SHA; liên kết SHA → deployment
  dựa trên clean worktree dùng để chạy lệnh deploy và cần được giữ trong hồ sơ
  phát hành.
- Health/readiness chỉ chứng minh các kiểm tra được endpoint thực hiện; không
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
- Không chạy provider hoặc gửi thông báo trong rollout này. Không có migration
  thuộc PR #1413.
- Bảng 30 tiêu chí V1 ngày 11/09 là nguồn ID/điều kiện. Các nhãn “chưa merge”
  trong báo cáo lịch sử được đối chiếu lại bằng Git/GitHub; không sửa lại lịch sử.
- `PASS QA`: đạt phạm vi QA đã nêu. `DEPLOYED`: code đã nằm trong SHA Live.
  `NOT PROVEN`: chưa đủ chứng cứ điều kiện đạt. `BLOCKED`: cần quyết định,
  quyền thao tác hoặc người tham gia thực tế. Không đồng nhất các nhãn này.

## 2. Bảy giai đoạn Masterplan

| Giai đoạn | Bằng chứng có thể xác nhận | Điều kiện còn thiếu để đóng |
|---|---|---|
| 1. Môi trường và đăng ký | Email/Auth recovery và trial đã có; Ngày 3 app-side Google contract local PASS 81/81 và build PASS | Google OAuth thật vẫn NOT_PROVEN: QA provider OFF và Preview chưa có branch-scoped QA environment; cần hosted QA E2E trước khi ký nghiệm thu |
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
| V1-01 | Bản phát hành/code/schema | PASS rollout #1413 ngày 21/09 trong phạm vi không migration: merge SHA và deployment READY được ghi nhận; health/readiness PASS | Với release có migration, bắt buộc thực hiện schema-first rehearsal/audit riêng; manual deploy hiện chỉ trả deployment ID ở `/api/version` |
| V1-02 | Trang salon | Có PASS HTTP lịch sử 11/09; chưa kiểm lại từng trang trong đợt này | Read-only UI smoke từng URL trong danh sách salon phát hành |
| V1-03 | Đăng ký salon mới | PARTIAL; Ngày 3 local chứng minh callback/membership/chống salon trùng và UI desktop/mobile, nhưng Google provider QA đang OFF | P0-02: cấu hình isolated Preview + Google QA, chạy hosted E2E rồi cleanup synthetic data |
| V1-04 | Đăng nhập/khôi phục | PASS QA lịch sử; CI #1413 recovery xanh | Ghép callback/email provider và salon trắng vào P0-02 |
| V1-05 | Cookie bảo mật | PASS QA lịch sử; code nằm trong main | Giữ regression trên ứng viên phát hành, không tính cookie lịch sử là kiểm tra phiên hiện tại |
| V1-06 | MFA SuperAdmin | PASS QA; CI #1413 MFA xanh | Quét QR/Authenticator trên máy thật nếu đưa vào ký nghiệm thu vật lý |
| V1-07 | Cấu hình salon | P1-04 PASS QA, PR #1410 đã deploy | Owner từng salon xác nhận catalog/giờ/thợ/resource |
| V1-08 | Tenant/role | PASS trong phạm vi tự động hiện hành: CI real-auth #1416 tenant roles/session revocation SUCCESS; Production metadata read-only có 241/241 public tables bật RLS | Giữ regression trên mỗi release có thay đổi auth/ACL; pilot người thật vẫn là bằng chứng riêng |
| V1-09 | Chống lạm dụng | QA PASS: durable quota + 48/48 focused tests; QA disposable migration/rehearsal/ACL/Advisor 0 ERROR; tenant E2E 18/18; Vercel Firewall version 9 có hai SDK rules runtime log-only. Production DB vẫn còn 1 Advisor ERROR đến khi hotfix được duyệt rollout riêng | Quan sát WAF log-only; review PR/Preview; chỉ xin Production migration sau CI/Preview PASS, rồi kiểm chứng Advisor 0 ERROR |
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
| V1-21 | Năm việc tiếp tân | P1-03 automated journey PASS | Người mới làm đủ năm việc và ghi thời gian |
| V1-22 | Queue/waitlist | P1-01/P1-03 synthetic UI PASS; #1406/#1407 đã deploy | Offer/claim đúng khách và terminal provider delivery có chứng cứ |
| V1-23 | Thông báo/reminder | P1-01 delivery truth đã deploy; synthetic callback PASS | Provider QA terminal delivery chưa hoàn tất trong hồ sơ; acceptance 24h/3h và opt-out |
| V1-24 | Admin một tay | Mobile QA một phần | iPhone vật lý: hôm nay/doanh thu/khách/lịch/cảnh báo |
| V1-25 | EN/VI và thiết bị | P1-03 bốn device/language profiles PASS | Profiles không phải phần cứng thật; hoàn tất matrix vật lý theo phạm vi phát hành |
| V1-26 | Incident và recovery | P1-06 drill/restore có bằng chứng; #1413 đã merge/deploy; CI và post-deploy verification PASS | Ghi người trực và thực hiện rehearsal vận hành trong pilot; rollout kỹ thuật không thay thế chứng cứ con người |
| V1-27 | Restore/offboarding | P1-06 PostgreSQL rehearsal lịch sử PASS | Gắn thời gian phục hồi, người phụ trách và recovery acceptance vào biên bản |
| V1-28 | Trial/giá/thanh toán | #1411 đã deploy; QA expiry/manual billing PASS | Chốt khác biệt self-pay Masterplan và activation thủ công V1; Preview Auth hạn chế còn được ghi nhận |
| V1-29 | AI brief nếu nằm trong V1 | NOT PROVEN riêng cho pilot | Chốt scope pilot; nếu bật phải kiểm nguồn và các hành động có rủi ro |
| V1-30 | Pilot/mở rộng | NOT PROVEN | Ba salon 7–14 ngày và KPI trước cohort 10 salon |

## 4. Hàng đợi đóng điểm chặn

| Mã | Bản sửa/QA đã có | Phần còn mở | Người thực hiện/bước kế tiếp |
|---|---|---|---|
| P0-01 | #1401 merged 11/09; #1404 merged 14/09; regression và diagnostics | Chưa chứng minh nguyên nhân từng 503 lịch sử; không tự tạo lỗi trên Live | Kỹ thuật: ghép log có request/stage/SHA nếu còn; ghi rõ giới hạn lịch sử |
| P0-02 | Auth/email/recovery synthetic có bằng chứng; Ngày 3 app-side Google local PASS (12 browser + 69 contract/unit) và build PASS | Google/provider hosted end-to-end và toàn bộ salon trắng; QA Google provider đang OFF, Preview PR #1418 chưa có QA env branch-scoped | QA + chủ tài khoản: phê duyệt cấu hình isolated Preview, OAuth QA account và cleanup; không tự gửi thư thử |
| P0-03 | QA disposable `uhpzafoiifupyypkcwln` đã nhận full migrations; rehearsal/ACL/Advisor 0 ERROR; tenant E2E 18/18; WAF version 9 có `booking-page-load` 60/60s/IP và `contact-submit` 5/3600s/IP, vượt ngưỡng chỉ log | Production Supabase vẫn còn 1 Advisor ERROR cho view đến khi hotfix được duyệt; WAF cần thời gian quan sát false positive; PR/Preview/CI chưa phải Production proof | Kỹ thuật: review PR/Preview, quan sát log-only, sau đó xin rollout migration riêng và kiểm chứng Production metadata/ACL/Advisor |
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
