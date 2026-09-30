# Rà soát Master Plan và worker hằng ngày

Ngày 30/09/2026, America/Vancouver. Code đối chiếu: `362dca4d028b40e3bcce52f67fac40fbc9caf07e`
(HEAD ban đầu, trùng `origin/main` theo `git ls-remote`). Checkout hiện tại trên
nhánh `work`, sạch trước lượt này. Không dùng worktree mới, không đổi ứng dụng,
schema, giá, dữ liệu salon, trạng thái gói hay cấu hình provider/Production.

Người dùng xác nhận: giữ **self-pay theo Master Plan** và chạy worker **hằng
ngày 09:00 Vancouver**, dừng khi đủ bằng chứng hoàn thành toàn bộ kế hoạch.

## Tác vụ đang chạy

- Danh sách collaboration chỉ có root; không có agent phụ của phiên này.
- Process list của máy chỉ có hạ tầng Codex/Docker, không có worker sửa NailIQ
  khác hoặc auto-push. Các dev/test processes từ onboarding không còn sống.
- GitHub HTTPS Git read hoạt động. GitHub PR/CI API trả `Forbidden` qua
  `api.github.com`; không kiểm chứng được PR hiện đang mở hoặc CI đang chạy.
- `codex cloud list --json --limit 10` không truy cập được endpoint danh sách
  task tại `chatgpt.com`. Không kết luận các task từ xa đã hoàn tất hoặc không
  tồn tại. Không có task nhìn thấy cần chờ; khi có quyền API phải đọc lại trước
  khi tạo PR hay sửa trùng một mục.
- Repo có Production Monitoring chạy mỗi 5 phút. Nó chỉ kiểm tra health và
  ghi incident; không phải agent tự sửa code. Không thay đổi lịch này.

## Cách tính tiến độ

Master Plan không quy định trọng số hoặc công thức phần trăm. Không quy số
test PASS thành phần trăm hoàn thành sản phẩm. Báo cáo hiện hành có 30 tiêu
chí V1 với các phạm vi code/local QA/hosted QA/Production/pilot khác nhau.

Worker sử dụng một thước đo bảo thủ, công khai: **số giai đoạn được nghiệm thu
đầy đủ / 7**. Snapshot mới ghi **0/7 (0%) đã đóng toàn bộ điều kiện**, vì chưa
có bộ nghiệm thu đầy đủ, có reviewer và source identity cho từng giai đoạn.
Đây **không phải 0% code đã viết**, cũng không phủ nhận các QA PASS lịch sử.
Không đưa ra con số 80–90% hoàn thành code khi chưa có mẫu số chức năng và
trọng số được xác định. Trạng thái từng phần ở bảng dưới hữu ích hơn cho việc
chọn công việc tiếp theo.

| Giai đoạn | Code/bằng chứng đã có | Phần còn thiếu để đóng |
|---|---|---|
| 1. Môi trường, đăng ký | `completeSalonRegistrationAction.ts`, defaults, cookie policy và trial resolver; hồ sơ Day 2/3 có hosted email/Google QA. Build/typecheck/HTTP đã PASS ở onboarding trên cùng baseline. | Bộ nghiệm thu đầy đủ trên ứng viên hiện hành, hành trình điện thoại và logs/Preview; chưa chạy hosted hoặc database từ máy hiện tại. |
| 2. UX tiếp tân | Năm luồng chính và profile desktop/mobile có hồ sơ Day 5; code Receptionist Center và regression đã tồn tại. | Người mới tạo hẹn/walk-in dưới 60 giây không hướng dẫn; bình thường/cao điểm với người thật. Không thay bằng thời gian robot. |
| 3. Admin iPhone | Owner/Admin dashboard, navigation, khách/doanh thu có QA Day 6 và fixture nhiều viewport. | Năm việc bằng một tay trên iPhone vật lý. |
| 4. Ổn định | Ranh giới tenant, release/offboarding, delivery claims và callback đã có code/tests. Day 9 ghi nhận terminal reminder trong DB nhưng không phải toàn bộ inbox/SMS/worker proof. | Đóng các cổng provider/callback/SMS/reminder/opt-out, xác nhận PR #1429 hiện hành, exact deployment source và acceptance release. Không mở hotfix trùng theo báo cáo lịch sử. |
| 5. Pilot | Biểu mẫu `day5-human-acceptance-sheet.md` và checklist pilot đã có. | Ba salon thật, 7–14 ngày, chủ lớn tuổi, hai tiếp tân ít dùng công nghệ, KPI và consent. Automation không tạo được bằng chứng này. |
| 6. Trial/self-pay | Trial 14 ngày, continuity 7 ngày và read-only; Core 39 CAD/tháng. Stripe actions, portal và webhook skeleton đã có. | `v1AllowsAutomatedSubscriptionBilling()` luôn `false`; giao diện chỉ kích hoạt thủ công. Cần durable replay/idempotency, self-pay Sandbox, thẻ lỗi/hủy gói/hóa đơn, nhắc trial 5/2/0 ngày và nghiệm thu khách tự thanh toán. Không bật gate cũ trước khi các hợp đồng này hoàn tất. |
| 7. Bán có kiểm soát | Master Plan mô tả cohort và funnel; không thấy bộ đo nghiệm thu đầy đủ. | Cohort tối đa 10 salon, 30 ngày dữ liệu và các mục tiêu conversion/support. Không coi việc có analytics code là đã đạt KPI. |

Nguồn chính: [Master Plan](../MASTER_PLAN.md),
[bảng nghiệm thu](MASTERPLAN_ACCEPTANCE_CURRENT.md),
[Day 9](p1-01-day9-current-evidence-2026-09-28.md),
[callback/reminder](masterplan-day-9-reminder-callback-boundary-2026-09-27.md),
[trial/billing](P1-05-TRIAL-PRICING-AUDIT-2026-09-15.md).

## Thay đổi đã làm trong lượt này

- Thêm `scripts/masterplan-progress.mjs` và manifest
  `docs/qa/masterplan-progress.json`: bảy giai đoạn, self-pay bắt buộc, receipt
  có reviewer/thời điểm/source SHA và tài liệu evidence trong repository.
- Gate không đóng khi thiếu bằng chứng, source đã thay đổi, còn code untracked,
  dùng manual activation thay self-pay, hoặc dùng automation thay nghiệm thu
  người thật. Pilot/cohort phải có khoảng quan sát và KPI đúng Master Plan.
- Thêm `.github/workflows/masterplan-worker.yml`: lịch UTC 16:00/17:00 được
  lọc qua timezone America/Vancouver để chọn 09:00 mùa hè/mùa đông. GitHub có
  thể trì hoãn scheduled runs; đây không phải cam kết chạy đúng giây.
- Một worker tại một thời điểm; có worker draft PR đang mở thì không tạo bản
  sửa mới. Đọc PR khác để tránh sửa trùng. Mỗi lượt chọn một mục P0/P1, chạy
  Codex workspace sandbox, validate và tạo draft PR. Không tự merge/deploy.
- Chỉ khi cả bảy giai đoạn có receipt được review và source còn khớp thì
  workflow gọi API disable chính nó. Bot không được sửa manifest nghiệm thu,
  worker/prompt, gate/tests hoặc Master Plan để tự tuyên bố 100%.

## Kiểm chứng

- **PASS:** 95/95 tests, 9/9 suites cho registration completion, cookie,
  pricing/trial, billing authorization, V1 scope, production release và
  offboarding. Providers/database được mock hoặc kiểm tra source; không phải
  hosted acceptance. Billing owner bị chặn trước Stripe theo predicate thật.
- **PASS:** 11/11 tests của progress gate: self-pay, evidence, source drift,
  missing/duplicate IDs, human acceptance, pilot/cohort time/KPI và DST.
  Integration test dùng repository Git disposable còn kiểm tra source thay
  đổi, code untracked, path traversal và evidence symlink ngoài thư mục QA.
- **PASS:** ESLint hai file JS mới; YAML parse và `bash -n` toàn bộ run steps.
- **PASS:** cài Codex CLI pinned `0.159.2` từ npm, kiểm tra version và parse
  chính xác các flags của lệnh worker. Chưa chạy API coding/authentication.
- **BLOCKED:** Chromium download tiếp tục HTTP 403 `Domain forbidden` tại
  `cdn.playwright.dev`, dù domain đã có trong configuration metadata.
- **BLOCKED:** Supabase Docker đã tải được một số layer, nhưng cấu hình image
  vẫn `Forbidden`; một số request ECR còn rate-limited. GHCR/Docker Hub
  fallback cũng bị chặn. Không có local database sẵn sàng hoặc backend E2E PASS.
- **NOT PROVEN:** GitHub workflow execution, Actions secret readiness,
  scheduled trigger, actual draft PR creation/disable and remote task status.

## Kích hoạt và công việc kế tiếp

1. Lưu thay đổi mạng nháp cho `api.github.com` và `chatgpt.com`, giữ các domain
   đã có. Hai domain download cũ vẫn lỗi ở runtime; cần xác minh policy/redirect
   bằng response thực trước khi thêm domain khác, không mở Internet toàn bộ.
2. Sau thay đổi runtime, đọc lại task/PR/CI và secret **metadata**, không in
   giá trị. Không yêu cầu token GitHub mới chỉ vì API hiện bị chặn: Git read
   vẫn hoạt động qua authentication được cấp sẵn.
3. Workflow dùng repository Actions secret `OPENAI_API_KEY`; chưa đọc được
   danh sách secret vì GitHub API bị chặn. Tái sử dụng nếu đã có; chỉ yêu cầu
   nhập giá trị an toàn trong GitHub Secrets nếu thiếu. Không đưa vào chat
   hoặc cloud proxy binding. Actions cần được phép tạo draft pull request.
4. Publish/review/merge workflow qua quy trình repo. Chỉ khi file vào default
   branch mới có cron GitHub. Chạy workflow_dispatch để xác minh worker,
   validate/draft PR trước khi gọi lịch đã hoạt động. **Hiện chỉ đã chuẩn bị
   code workflow ở checkout, chưa kích hoạt cron.**
5. Ưu tiên P0/P1 còn mở: xác minh release/source/PR, notification provider
   acceptance có phạm vi được duyệt; không gửi thật bằng phê duyệt cũ đã hết.
   Sau đó hoàn thiện self-pay durable contract + synthetic/Sandbox acceptance.
   Không đổi gate Production hoặc giá khi chưa kiểm chứng.
6. Người dùng/Owner cung cấp nghiệm thu thiết bị/pilot/cohort thực tế và review
   receipt. Cập nhật manifest qua PR được review; không sửa lịch sử thành PASS.
   Sau khi 100% được chứng minh, workflow disable chính nó. Nếu code thay đổi
   sau đó, reviewer cần mở lại tiêu chí và enable workflow thủ công.

Các kiểm tra localhost/onboarding không đóng release, provider, pilot hoặc
toàn bộ Master Plan. Lượt này không phát sinh provider sends, payment hay
Production mutation. Chưa có cơ sở tuyên bố hoàn thành 100%.

## Checkpoint sau khi lưu mạng

- GitHub API đã truy cập được; `origin/main` vẫn ở `362dca4d`.
- Không thấy GitHub Actions ở trạng thái queued/in_progress tại lúc đọc.
- PR #1439 (SMS callback fence) và #1441 (pilot evidence kit) đã có các check
  bắt buộc SUCCESS. Các job có điều kiện SKIPPED không được tính PASS; các PR
  vẫn Draft, không merge/deploy trong lượt này.
- Self-pay đã có Draft #1246 `fix/billing-idempotency-guard`, head `c769e00b`.
  Nó là stacked PR trên một nền cũ, chưa có current-main/provider acceptance.
  Không viết lại một nhánh billing trùng hoặc merge bản này chỉ vì CI cũ xanh.
- Secrets API trả 403 `Resource not accessible by integration`: đây là thiếu
  quyền metadata, không chứng minh thiếu secret. Codex Cloud task list trả
  401 `Could not parse your authentication token`: trạng thái task Cloud vẫn
  chưa xác minh, không còn được phân loại đơn thuần là lỗi network.
- Worker còn kiểm tra active CI trước khi sửa code, bỏ qua lượt có CI/worker
  PR khác. Không đổi Production Monitoring.
