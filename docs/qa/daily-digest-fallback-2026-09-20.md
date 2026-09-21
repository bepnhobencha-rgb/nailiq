# Hi-Lite daily digest — sửa lỗi bỏ qua email khi AI thất bại

## Phạm vi và bằng chứng

- Incident: báo cáo ngày 2026-09-20, America/Los_Angeles.
- Production đã đối chiếu ở lượt điều tra: `ff607477d47dbed15602ed7dcf9caeac087b87e9`, deployment `dpl_HGUpED6oc7713Gf7dLaJjrpzC4Cq`.
- Manager bắt đầu 2026-09-21 04:00:41 UTC (21:00:41 tại salon), kết thúc 04:01:28 UTC, báo succeeded/0 failures.
- Usage digest của Hi-Lite lúc 04:01:03 UTC: failed, error_code=Error, latency_ms=20004. Phù hợp timeout 20 giây; log không đủ để khẳng định loại lỗi provider cụ thể.
- Hôm đó không có `digest_sent`; hai ngày trước có. Unified digest ON, notification enabled, hai người nhận, salon active. Optimization flag không bật.
- Không lưu email, customer data, secrets hoặc nội dung prompt trong report.

## Nguyên nhân

`draftDigest` trả null khi AI lỗi/cắt ngắn/rỗng. Nhánh chưa bật optimization không có fallback, `runDigest` thoát bình thường; manager coi là ok. Email chưa đến bước gửi nhưng cron báo thành công.

## Implemented locally

- Worktree riêng: `/Users/huytran/nailiq-daily-digest-fallback-20260920`.
- Branch `fix/daily-digest-fallback-20260920`, base đúng Production SHA ở trên; không trộn PR #1413 hoặc các migration OTP.
- Fallback deterministic hiện có áp dụng cho cả hai nhánh flag khi AI lỗi, timeout, cắt ngắn, nội dung không hợp lệ hoặc không có AI key. Không gửi raw prompt context.
- Phân biệt typed sent/skipped; manager ghi reason khi bỏ qua có chủ đích, không đếm skip thành một lần gửi thành công.
- Chỉ ghi nhận sent sau provider message ID không rỗng và RPC lưu receipt thành công. Đây là provider acceptance, không phải bằng chứng email vào Inbox.
- Lỗi đọc salon, lịch sử gửi, booking totals, actions hoặc alerts phải báo thất bại, không dùng số 0 giả.
- Giữ nguyên tenant/cron authorization, notification opt-out, lịch 21h, feature flags, recipients, template, provider idempotency key và cùng-ngày dedupe. Không migration.

## Tested locally

Tất cả kiểm thử dùng mock/synthetic. Test fallback chặn global fetch; Anthropic, Resend và DB đều mock. Không sao chép .env hoặc dùng credential thật.

Dependency dùng node_modules có sẵn từ worktree p1-06; package-lock hai bên cùng SHA256 `f0ad32f7c9e6ec5e7a57f31405c0fa00f46f0c2aee811f917d65924fe4adebd0`. Không cài/cập nhật dependency.

Lệnh (chạy từ worktree):

```sh
env -i PATH="$PATH" DISABLE_OUTBOUND_SMS=1 DISABLE_OUTBOUND_EMAIL=1 node_modules/.bin/vitest run src/shared/ai/__tests__/agentDigestFallback.spec.ts src/shared/ai/__tests__/agentDigestDelivery.spec.ts src/shared/ai/__tests__/managerRunSummary.spec.ts src/shared/ai/__tests__/managerExceptionSignals.spec.ts src/shared/ai/__tests__/ruleFirstOptimization.spec.ts src/shared/ai/__tests__/anthropicProviderPolicy.spec.ts src/shared/ai/__tests__/usageLedger.spec.ts src/shared/ai/__tests__/executionHeartbeatPrivacy.spec.ts src/shared/ai/__tests__/tenantExecutionBoundary.spec.ts src/app/api/cron/manager/route.spec.ts --silent
env -i PATH="$PATH" node_modules/.bin/eslint src/shared/ai/agentDigest.ts src/shared/ai/managerRunSummary.ts src/app/api/cron/manager/route.ts src/app/api/cron/manager/route.spec.ts src/shared/ai/__tests__/agentDigestFallback.spec.ts src/shared/ai/__tests__/managerRunSummary.spec.ts
env -i PATH="$PATH" DISABLE_OUTBOUND_SMS=1 DISABLE_OUTBOUND_EMAIL=1 npm run typecheck
env -i PATH="$PATH" NEXT_TELEMETRY_DISABLED=1 DISABLE_OUTBOUND_SMS=1 DISABLE_OUTBOUND_EMAIL=1 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:9 NEXT_PUBLIC_SUPABASE_ANON_KEY=local-placeholder-not-a-key SUPABASE_SERVICE_ROLE_KEY=local-placeholder-not-a-key npm run build -- --webpack
git diff --check
```

- Unit/regression: **98/98 PASS, 10 files**, gồm 39 test fallback mới và 6 test manager mới.
- Typecheck: PASS.
- ESLint touched files: PASS.
- Diff whitespace: PASS.
- Build: **PASS**, `next build --webpack`, exit 0; hoàn thành 61/61 trang static. Có cảnh báo không chặn build về Edge Runtime deprecated và trang Edge không static generation; chưa sửa ngoài phạm vi hotfix.
- Independent test/review: không phát hiện P0/P1 mới trong diff.

## Chưa chứng minh / release boundary

- Chưa Preview, chưa deploy Production, chưa gửi email thật hoặc kiểm Inbox.
- Không tự động gửi bù hôm 20/9. Cần approval riêng sau khi đối chiếu receipt để tránh gửi trùng.
- Không thêm automatic retry/catch-up. Stable key hiện có được giữ, nhưng retry với payload thay đổi (AI prose/dữ liệu/approval token) cần thiết kế persisted immutable payload; không hứa retry đầy đủ từ test local.
- Thời điểm 21h và mất lần chạy cron vẫn chưa có catch-up queue trong hotfix này. Không tăng timeout AI, không thêm provider call khi test.
- Các helper phụ `loadUnclosedBookings`/outcome giữ nguyên contract best-effort hiện có; không tuyên bố mọi dữ liệu phụ đã fail-closed.
- Không đổi UI/layout; đây là kiểm thử backend mock, không phải UI E2E hay provider proof.

## Rollback và quyền

Rollback code: bỏ/revert đúng hotfix này; không có schema/data rollback. Không thay đổi salon flags. Chưa commit, push, mở PR, merge/deploy hoặc sửa Production.

## Production release approval — 2026-09-20

- Sau báo cáo local, Huy yêu cầu “live”: cho phép phát hành riêng hotfix này qua commit/push/PR và merge/auto-deploy khi gate PASS.
- Recheck trước phát hành: `origin/main` và Production `/api/version` vẫn là `ff607477d47dbed15602ed7dcf9caeac087b87e9`; không cần rebase hoặc trộn thay đổi khác.
- Chạy lại suite liên quan: 98/98 PASS. Build/typecheck/lint ở trên áp dụng đúng source candidate không thay đổi.
- Không gọi cron thủ công hoặc gửi bù email; không đổi flags, recipients, secrets hay schema. Việc email vào Inbox vẫn cần bằng chứng riêng từ lần gửi được phép/lịch vận hành bình thường.
- Trạng thái PR/CI/deployment sẽ được ghi trong báo cáo phát hành; mục local phía trên là checkpoint trước publish, không phải bằng chứng deployment.
