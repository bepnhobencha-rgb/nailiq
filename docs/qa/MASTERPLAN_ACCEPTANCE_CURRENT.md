# NailIQ — Bảng nghiệm thu Masterplan

Cập nhật: 20/09/2026. Đây là bảng theo dõi nghiệm thu hiện hành; không thay đổi
phạm vi, chính sách hay điều kiện đạt trong `docs/MASTER_PLAN.md`.

**Kết luận: chưa đủ bằng chứng nghiệm thu toàn bộ Masterplan.** Không quy đổi
số test xanh thành phần trăm chức năng hoàn thành. Thiếu bằng chứng không đồng
nghĩa đã xác nhận có lỗi.

## 1. Mốc và cách đọc

- `origin/main`: `ff607477d47dbed15602ed7dcf9caeac087b87e9`, đã fetch ngày 20/09.
- Production kiểm tra trực tiếp lúc `2026-09-20T18:04:12.186Z`: cùng SHA trên;
  `/api/version`, `/api/health`, `/api/ready` đều PASS ngay lần đầu.
- Health/readiness chỉ chứng minh các kiểm tra được endpoint thực hiện; không
  chứng minh mọi migration/ACL, mọi salon hay mọi hành trình khách hàng đều đúng.
- Ứng viên phát hành P1-06: `9fe579aecb878391061a082bf6ab8223f3045415`,
  [PR #1413](https://github.com/bepnhobencha-rgb/nailiq/pull/1413), OPEN,
  Ready for review, MERGEABLE. Các check đã chạy SUCCESS; hai check SKIPPED
  không được tính PASS. Đây là kết quả CI ngày 16/09 được đọc lại ngày 20/09.
- Lần này chạy lại ba suite release/offboarding: **20/20 PASS**.
- Chưa chạy lại UI, full unit, build, database rehearsal hoặc provider trong
  đợt này. Các bằng chứng đó bên dưới là kết quả lịch sử được ghi rõ nguồn.
- Bảng 30 tiêu chí V1 ngày 11/09 là nguồn ID/điều kiện. Các nhãn “chưa merge”
  trong báo cáo lịch sử được đối chiếu lại bằng Git/GitHub; không sửa lại lịch sử.
- `PASS QA`: đạt phạm vi QA đã nêu. `DEPLOYED`: code đã nằm trong SHA Live.
  `NOT PROVEN`: chưa đủ chứng cứ điều kiện đạt. `BLOCKED`: cần quyết định,
  quyền thao tác hoặc người tham gia thực tế. Không đồng nhất các nhãn này.

## 2. Bảy giai đoạn Masterplan

| Giai đoạn | Bằng chứng có thể xác nhận | Điều kiện còn thiếu để đóng |
|---|---|---|
| 1. Môi trường và đăng ký | Có môi trường QA, Auth recovery và trial; code hiện tại đã deploy | Email/Google → salon trắng → 14 ngày → đúng Dashboard trên điện thoại với chứng cứ đầy đủ; Google QA còn deferred trong hồ sơ R11 |
| 2. Tiếp tân | Năm việc cốt lõi đã có QA desktop/WebKit; sửa UX nằm trong PR #1409 đã merge | Người mới tạo hẹn dưới 60 giây và walk-in dưới 30 giây; xác nhận chế độ thường/cao điểm với người dùng |
| 3. Admin iPhone | QA profile iPhone SE/Pro Max/iPad có bằng chứng | Dùng một tay trên iPhone vật lý và hoàn tất năm việc Admin |
| 4. Ổn định | Các sửa P0/P1 #1401, #1404–#1411 đã vào main; probe Live hiện tại PASS | Đóng từng acceptance còn mở; triển khai phòng ngừa sự cố #1413; đủ bằng chứng thông báo/provider |
| 5. Pilot | Hai salon Live là bối cảnh vận hành, không thay biên bản pilot | Ba salon, thành phần người dùng đúng yêu cầu, 7–14 ngày, số đo và kết luận |
| 6. Trial/thanh toán | PR #1411 triển khai trial 14 ngày + 7 ngày continuity + read-only; activation V1 thủ công theo báo cáo đã duyệt | Masterplan còn yêu cầu tự thanh toán: cần xác nhận phạm vi nghiệm thu V1 thủ công hoặc xây/chứng nhận riêng self-pay; không tự đổi chính sách |
| 7. Bán có kiểm soát | Chưa tìm thấy bằng chứng đủ trong bộ hồ sơ được kiểm tra | Cohort 10 salon, funnel 30 ngày, hỗ trợ và tỷ lệ chuyển đổi có dữ liệu |

## 3. Ma trận 30 tiêu chí V1

Các PASS lịch sử chỉ có giá trị trong phạm vi đã thử, không phải rerun trên SHA
ngày 20/09. Nguồn viết tắt được giải thích ở mục 6.

| ID | Tiêu chí | Trạng thái/bằng chứng | Việc cần đóng tiếp theo |
|---|---|---|---|
| V1-01 | Bản phát hành/code/schema | PASS probe Live 20/09; code khớp main. Chưa full schema/ACL audit mới | Dùng schema-first runbook cho #1413; ghi SHA và bằng chứng sau phát hành |
| V1-02 | Trang salon | Có PASS HTTP lịch sử 11/09; chưa kiểm lại từng trang trong đợt này | Read-only UI smoke từng URL trong danh sách salon phát hành |
| V1-03 | Đăng ký salon mới | PARTIAL; R11 còn Google QA deferred | P0-02: hoàn thành từng phương thức đăng ký đã chọn bán |
| V1-04 | Đăng nhập/khôi phục | PASS QA lịch sử; CI #1413 recovery xanh | Ghép callback/email provider và salon trắng vào P0-02 |
| V1-05 | Cookie bảo mật | PASS QA lịch sử; code nằm trong main | Giữ regression trên ứng viên phát hành, không tính cookie lịch sử là kiểm tra phiên hiện tại |
| V1-06 | MFA SuperAdmin | PASS QA; CI #1413 MFA xanh | Quét QR/Authenticator trên máy thật nếu đưa vào ký nghiệm thu vật lý |
| V1-07 | Cấu hình salon | P1-04 PASS QA, PR #1410 đã deploy | Owner từng salon xác nhận catalog/giờ/thợ/resource |
| V1-08 | Tenant/role | CI #1413 tenant roles/session revocation SUCCESS | Ghép đầy đủ phép đọc/ghi và thu hồi quyền vào ma trận P0-03 |
| V1-09 | Chống lạm dụng | PR #1405 đã deploy; có guard trong code | Kiểm chứng cấu hình quota/WAF hiện hành; không kết luận từ tên PR |
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
| V1-26 | Incident và recovery | P1-06 drill/restore có bằng chứng; 20 tests rerun PASS | #1413 chưa merge/deploy; ghi người trực và release verification |
| V1-27 | Restore/offboarding | P1-06 PostgreSQL rehearsal lịch sử PASS | Gắn thời gian phục hồi, người phụ trách và recovery acceptance vào biên bản |
| V1-28 | Trial/giá/thanh toán | #1411 đã deploy; QA expiry/manual billing PASS | Chốt khác biệt self-pay Masterplan và activation thủ công V1; Preview Auth hạn chế còn được ghi nhận |
| V1-29 | AI brief nếu nằm trong V1 | NOT PROVEN riêng cho pilot | Chốt scope pilot; nếu bật phải kiểm nguồn và các hành động có rủi ro |
| V1-30 | Pilot/mở rộng | NOT PROVEN | Ba salon 7–14 ngày và KPI trước cohort 10 salon |

## 4. Hàng đợi đóng điểm chặn

| Mã | Bản sửa/QA đã có | Phần còn mở | Người thực hiện/bước kế tiếp |
|---|---|---|---|
| P0-01 | #1401 merged 11/09; #1404 merged 14/09; regression và diagnostics | Chưa chứng minh nguyên nhân từng 503 lịch sử; không tự tạo lỗi trên Live | Kỹ thuật: ghép log có request/stage/SHA nếu còn; ghi rõ giới hạn lịch sử |
| P0-02 | Auth/email/recovery synthetic có bằng chứng | Google/provider end-to-end và toàn bộ salon trắng | QA + chủ tài khoản: ca QA được kiểm soát, không tự gửi thư thử |
| P0-03 | Tenant/role CI xanh; #1405 merged | Ma trận quyền + quota/WAF runtime hiện hành | Kỹ thuật: tổng hợp phép đọc/ghi và kiểm cấu hình read-only |
| P1-01 | #1406/#1407 merged; synthetic delivery truth PASS | Provider delivery/callback acceptance | QA: chuẩn bị người nhận/case cụ thể trước một lượt provider được phép |
| P1-02 | #1408 merged; Sandbox/backend/browser PASS | Live exception recovery cần Owner; dữ liệu cũ không đại diện hôm nay | Owner + QA: duyệt từng trường hợp sau snapshot read-only mới |
| P1-03 | #1409 merged; profile EN/VI PASS | Người mới, thời gian, máy thật | QA/pilot: ghi từng nhiệm vụ, số trợ giúp và kết quả |
| P1-04 | #1410 merged; 60 browser PASS, 3 SKIP; 32 unit PASS theo báo cáo | Attestation đúng cấu hình từng salon | Owner + QA: xác nhận cấu hình và rehearsal không dùng khách thật |
| P1-05 | #1411 merged; giá/trial/manual activation đã có QA | Scope self-pay khác Masterplan; authenticated Preview chưa proven | Huy chốt phạm vi thương mại; kỹ thuật giữ nguyên chính sách đã triển khai |
| P1-06 | #1413 Ready, CI xanh; 20 tests rerun PASS | Chưa có quyền merge/rollout mới; prevention chưa Live | **Hạng mục kỹ thuật đang tiếp tục**: hoàn tất hồ sơ review rồi chờ duyệt rollout #1413 |
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
- Nguồn 30 ID: bản local lịch sử
  `/Users/huytran/nailiq-v1-acceptance-20260911/docs/qa/V1_ACCEPTANCE_2026-09-11.md`;
  không coi file local này là tài liệu đã merge.

Lệnh đã chạy trong đợt này:

```sh
git fetch origin main
gh pr list --state merged --limit 20 --json number,title,mergedAt,mergeCommit
gh pr view 1413 --json state,headRefOid,mergeable,statusCheckRollup,url,body
node scripts/monitor-production-health.mjs --base-url https://www.nailiq.ca --allow-production-read-only
./node_modules/.bin/vitest run src/shared/security/__tests__/productionReleaseBoundary.spec.ts src/shared/security/__tests__/staffOffboardingBoundary.spec.ts src/shared/security/__tests__/staffOffboardingDurableNotificationBoundary.spec.ts
```

Không có commit/push/merge/deploy, migration, provider send, booking mới hoặc
thay đổi salon trong đợt cập nhật này. Bảng này cần cập nhật theo evidence mới;
không tự chuyển NOT PROVEN thành PASS khi thời gian trôi qua.
