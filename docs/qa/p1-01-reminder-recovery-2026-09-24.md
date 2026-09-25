# P1-01 — Gửi bù reminder có giới hạn 60 phút

Phạm vi được Huy duyệt qua `N` sau đề xuất 60 phút: triển khai local/QA,
không commit/push/deploy hoặc gửi tin thật. Ngày: 24/09/2026 Vancouver.
Base HEAD `733d44e0f9256f343b181dc8a5f66434dfd02ac7` trong worktree
`/private/tmp/nailiq-waitlist-server-qa-20260924`. Các thay đổi tài liệu từ lượt
trước được giữ nguyên. Không kiểm chứng deployment Production trong lượt này.

## Hành vi đã triển khai local

- Giữ nguyên cửa sổ chọn reminder thường ±15 phút. Query riêng claim `failed`,
  còn dưới 3 attempts, không provider receipt và chỉ các lỗi chắc chắn trước gửi.
- Thời hạn tính từ **giờ nhắc dự kiến** = giờ hẹn trừ 24h/3h. Recovery sau phút
  15 đến hết phút 60; không cộng thêm 60 phút vào mép cửa sổ. Deadline kiểm lại
  trong handler và ngay trước Resend SDK/Twilio fetch sau các bước async.
- Hydrate lại booking/salon, đối chiếu salon + booking + occurrence; chỉ pending/
  confirmed, quyền reminder/entitlement/channel và suppression hiện hữu vẫn áp dụng.
  RPC claim hiện hữu kiểm lại trạng thái/occurrence, khóa cạnh tranh và giới hạn 3
  attempts tổng cộng. Unknown/sending/sent/suppressed không thành recovery mới.
- Chỉ gửi kênh failed được chọn. Group member được xử lý độc lập dù group marker
  đã có; organizer recovery không fan-out gửi mới cho các thành viên. Thành viên
  quá deadline cũng không đi vòng qua luồng organizer thường.
- Email recovery bỏ AI và dùng ngày giờ hẹn thực tế; SMS EN/VI dùng ngày, năm,
  giờ và timezone của salon, giữ link và STOP. Email nhóm không hứa “còn 3 giờ”.
- Không đánh dấu shared group/booking marker khi catch-up. Claim terminal là
  bằng chứng chống gửi trùng. `recoverySettled` là số work item đã xử lý/settled
  (có thể gồm suppressed hoặc claim đã settled bởi worker khác), **không phải**
  số tin được gửi hay được nhận.
- Hết hạn trong bước chuẩn bị: lưu `recovery_window_expired`, không gọi provider.
  Các claim failed đã quá hạn trước discovery được giữ nguyên, không xóa hoặc
  đổi thành sent. Chưa bổ sung màn hình báo cáo missed riêng.
- Discovery giới hạn 200 claim mỗi loại/lượt để giới hạn work; chưa load-test
  backlog lớn. Không tự gửi bù tin chưa từng có failed claim khi cron bị outage.

## File implementation/test

- `src/app/api/cron/reminders/route.ts`: discovery và điều phối recovery.
- `src/shared/reminders/reminderSchedule.ts`: deadline/window/date copy thuần.
- `src/shared/reminders/reminderDeliveryClaims.ts`: phân loại hết hạn không gửi.
- `src/shared/noshow/sendReminderEmail.ts`: deterministic copy/deadline email.
- `src/shared/lib/twilioSms.ts`: deadline ngay trước provider POST.
- `src/app/api/cron/reminders/route.runtime.spec.ts`: mock I/O, chặn network.
- `src/shared/reminders/__tests__/reminderRecovery.spec.ts` và
  `reminderProviderDeadline.spec.ts`: biên thời gian/DST, slow-preflight no-send.
- `src/shared/noshow/__tests__/reminderEmailBranding.spec.ts`: EN/VI group copy.
- `scripts/security/rehearse-booking-reminder-delivery-claims.sql`: thêm giới hạn
  3 attempts, từ chối occurrence cũ sau đổi giờ và booking đã hủy.

## Kết quả thật

```sh
./node_modules/.bin/vitest run src/app/api/cron/reminders/route.runtime.spec.ts src/shared/reminders/__tests__ src/shared/noshow/__tests__/reminderEmailBranding.spec.ts src/shared/noshow/__tests__/sendReminderEmailTimeout.spec.ts src/shared/security/__tests__/reminderWorkerFailureBoundary.spec.ts src/shared/security/__tests__/reminderOutboundKillSwitchBoundary.spec.ts src/shared/security/__tests__/reminderEmailEvidenceBoundary.spec.ts src/shared/security/__tests__/smsSingleDispatcherPolicy.spec.ts src/shared/security/__tests__/smsDeliveryTruthAcceptance.spec.ts src/shared/security/__tests__/smsConsentRuntimeAcceptance.spec.ts src/shared/lib/__tests__/smsDeliveryTruth.spec.ts
node /private/tmp/nailiq-p101-concurrency-qa.mjs --reminder
npm run typecheck
git diff --check
```

- **167 tests / 17 suites PASS**, không retry/skip. Test runtime không kết nối
  DB/provider; SDK/fetch mocked. Network stub chặn mọi cuộc gọi thật.
- PostgreSQL local disposable: SQL rehearsal mở rộng và concurrent claim PASS;
  transaction rollback + cleanup sau race; 10 bảng có số row trước/sau như nhau,
  salon 0 và không cron active. Không migration.
- Typecheck, lint các file TS thay đổi, diff check PASS.
- Build webpack PASS, exit 0, 61/61 static pages; môi trường sạch, credential
  giả và API loopback cổng 1, outbound/telemetry OFF. Lệnh như receipt
  `p1-01-reminder-boundaries-2026-09-24.md`. Cảnh báo Edge Runtime deprecated và
  Vite config loader còn nguyên. Không deploy build này.
- Rà soát độc lập phát hiện ba điểm ban đầu (deadline quá sớm, metric gây hiểu
  nhầm, thành viên nhóm vượt hạn) và đã sửa/test lại; vòng cuối không thấy blocker.

## Follow-up — handler với PostgreSQL local thật

- Lệnh `node /private/tmp/nailiq-p101-concurrency-qa.mjs --handler` chạy riêng
  `src/app/api/cron/reminders/route.local-integration.spec.ts`, với opt-in
  `NAILIQ_LOCAL_REMINDER_INTEGRATION=1`. Mặc định CI không kết nối DB cho suite này.
- Runner kiểm API `127.0.0.1:54321`, DB `127.0.0.1:54322`, salon=0, cron active=0,
  không dotenv và fixture category chưa tồn tại. Key local lấy từ CLI trong memory
  rồi truyền vào child env; không in hoặc lưu key vào file. Mọi fetch ngoài đúng
  origin loopback bị test chặn.
- Handler GET, truy vấn Supabase/PostgREST, entitlement và claim/completion RPC
  dùng code thật + DB thật. Provider, token mint, notification log phụ, heartbeat
  wrapper và email suppression lookup được mock. Không gọi cron endpoint hosted.
- Lượt đầu 8 ca: hai ca lỗi setup do fixture cố phục hồi booking đã hủy; DB trả
  `42501 terminal booking restore is unavailable in V1`. Đây là safeguard hoạt
  động đúng. Sửa fixture thành tạo booking synthetic mới từng ca, không sửa DB
  guard. Lượt tiếp theo 8/8 PASS; thêm biên chính xác/unknown rồi **10/10 PASS**.
- 10 ca: recovery 24h và 3h; hai worker đồng thời một mocked send; chỉ 3 attempts
  tổng cộng; quá hạn không gửi; đúng 60 phút được chọn; unknown không retry; hủy;
  đổi occurrence; suppression không gọi sender. Kiểm receipt DB thật sau hành vi.
- Cleanup cuối dùng fixture IDs riêng đã xác minh trước; kiểm độc lập số row
  10 bảng trước/sau bằng nhau, salon=0. Dọn cả sau lượt FAIL. Không xóa dữ liệu
  khách, không hosted QA/Production, không email/SMS/provider thật.
- Typecheck/lint test mới/diff check PASS. Không đổi application code trong
  follow-up này; build PASS phía trên vẫn thuộc cùng application diff.

## Chưa được chứng minh / phát hành

- Handler → local API/DB → ledger đã PASS trong follow-up, provider vẫn mock;
  không gọi là hosted/provider E2E. Group recovery mới có runtime mock coverage,
  chưa nằm trong suite local DB 10 ca này.
- Chưa Preview/Production, UI người dùng hoặc provider/inbox/điện thoại thật.
- Chưa kiểm outage không có claim, backlog >200/loại, chưa có missed dashboard.
- Không thay Supabase hosted, credential, cấu hình provider, cron hay salon Live.
- Rollback sau phát hành nếu được duyệt: quay lại application build trước;
  không xóa claim ledger hoặc reset attempts. Không có migration cần rollback.

**Trạng thái:** implemented/tested locally; chưa deployed, chưa production-verified.
P1-01 tổng thể vẫn NOT COMPLETE.

## Publication preflight — 24/09/2026 Vancouver

- Owner approved commit/push and Draft PR/Preview only; no merge/Production,
  migration or real notifications/provider calls.
- New branch `fix/reminder-recovery-20260925` starts from main
  `038d7e2f7fdbc947aa99096247df17b7b268fbc0`; its tree matches the previous
  tested base. PR #1426 is already merged and is not reused.
- Re-ran 167 tests/17 suites, typecheck, touched-file ESLint and webpack build:
  PASS, 61/61 static pages. Existing Edge/Vite warnings remain.
- Added branch-specific Git auto-deployment fence in `vercel.json`. Manual
  Preview follows verified isolated QA configuration, never inherited Production.
- Initial Preview configuration was rejected because the new branch was not yet
  on GitHub (HTTP 400). No deployment was started. Publish the fenced branch,
  then configure and verify QA before creating Preview.
- Unrelated callback/acceptance working-tree notes remain uncommitted.
