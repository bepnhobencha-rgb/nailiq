# P1-01 — local reminder boundary follow-up

## Result

Local-only follow-up after the approved single-email Waitlist QA receipt.
No provider calls, database mutations, cron invocation, commit, push or deploy.
Production code unchanged; only regression tests and acceptance documentation changed.

- Before additions: 63 tests / 10 suites PASS.
- Added 7 cases: fall-back 24h/3h windows, year boundary, equivalent timestamp
  representations, adjacent-run overlap, and three invalid numeric/Date inputs.
- After additions: **70 tests / 10 suites PASS**, no retries or skips.
- Touched-file ESLint, `git diff --check`, `npm run typecheck`: PASS.
- Diff inspected. No Next build or new UI test: this batch changes no application
  implementation or UI, only tests and evidence. Prior UI/provider proof stays separate.

## Exact checks

Run from the isolated QA worktree with a clean environment and outbound flags OFF:

```sh
env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" DISABLE_OUTBOUND_SMS=1 DISABLE_OUTBOUND_EMAIL=1 DISABLE_OUTBOUND_CALLS=1 ./node_modules/.bin/vitest run src/shared/reminders/__tests__/reminderScheduleDst.spec.ts src/shared/reminders/__tests__/smsConsentSuppression.spec.ts src/shared/reminders/__tests__/reminderDeliveryClaims.spec.ts src/shared/reminders/__tests__/inboundSmsCommand.spec.ts src/app/api/webhooks/resend/route.spec.ts src/shared/security/__tests__/reminderOutboundKillSwitchBoundary.spec.ts src/shared/security/__tests__/registeredEmailDeliveryTruthBoundary.spec.ts src/shared/security/__tests__/bookingReminderDeliveryClaimBoundary.spec.ts src/shared/security/__tests__/waitlistTerminalDeliveryTruthBoundary.spec.ts src/shared/noshow/__tests__/waitlistDeliveryTruth.spec.ts
./node_modules/.bin/eslint src/shared/reminders/__tests__/reminderScheduleDst.spec.ts
git diff --check
npm run typecheck
```

Vite emitted its existing config-loader compatibility warning; tests exited 0.
Window overlap assertions do not establish delivery deduplication; durable claims
and concurrency acceptance remain separate. Mocked STOP/opt-out and signed callback
tests are not real hosted provider evidence.

## Remaining gates

### Subsequent local signature verification

Added `src/app/api/webhooks/resend/route.signature.spec.ts`: 13 cases using the
actual installed Resend/Svix verifier and independently constructed HMAC signatures.
Signing material is a public synthetic fixture, not a provider credential. Database
access is mocked; global fetch throws and every case asserts no fetch occurred.
Cases cover valid fingerprint-only persistence, tampering, wrong key, stale/future
timestamps, all three missing signature headers, wrong QA reference/environment or
recipient, multiple recipients, and Production-runtime rejection before DB access.

Re-ran the exact 10-suite command above with the additional argument
`src/app/api/webhooks/resend/route.signature.spec.ts`: **83/83 tests, 11 suites PASS**,
no retries/skips. New-file ESLint, `npm run typecheck`, and `git diff --check` PASS.
No application implementation changes, external calls, sends, database writes,
commit/push/deploy, new UI test or Next build. This proves local cryptographic
verification and scope enforcement, not hosted routing or durable database behavior.

### Still open

### Kiểm chứng PostgreSQL local tiếp theo — 24/09/2026

- Chạy `node /private/tmp/nailiq-p101-receipt-qa.mjs`, dùng rehearsal có sẵn
  `scripts/security/rehearse-registered-email-delivery-truth.sql`.
- Runner chỉ chấp nhận API loopback 127.0.0.1:54321 và PostgreSQL
  127.0.0.1:54322/postgres, không dotenv, không salon có sẵn, không cron active.
  Lần đầu sandbox chặn Docker socket trước khi kết nối database; chạy lại với
  quyền truy cập local được cấp và thành công. Không đổi cấu hình Docker/DB.
- **PASS trên PostgreSQL thật:** event_applied; retry idempotent chỉ một row;
  payload thay đổi trả event_conflict; email.sent chỉ là provider_accepted;
  projection trả receipt; registry key sai bị từ chối; ACL đúng; không có
  cột lưu email/subject/body thô trong bảng receipt.
- Transaction ROLLBACK hoàn tất; số receipt trước/sau bằng nhau; salon vẫn 0.
  Không migration, commit/push/deploy, hosted QA/Production hoặc provider call.
- Đây là kiểm chứng hàm SQL thật riêng biệt với test route/signature, chưa
  phải E2E liên thông HTTP → database và chưa chứng minh callback hosted.

### Điều kiện còn thiếu sau kiểm chứng database

### Kiểm tra build local — 24/09/2026

Chạy trong môi trường sạch, không credential thật, Supabase trỏ loopback cổng 1
(không kết nối QA/Production); outbound SMS/email/call OFF và telemetry OFF:

```sh
env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" NEXT_TELEMETRY_DISABLED=1 DISABLE_OUTBOUND_SMS=1 DISABLE_OUTBOUND_EMAIL=1 DISABLE_OUTBOUND_CALLS=1 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:1 NEXT_PUBLIC_SUPABASE_ANON_KEY=synthetic-build-only SUPABASE_SERVICE_ROLE_KEY=synthetic-build-only npm run build -- --webpack
```

- Build mặc định Turbopack không hoàn tất: đứng ở compile khoảng 4 phút,
  không có diagnostic lỗi; dừng đúng tiến trình build này (exit 143).
  Chưa xác định nguyên nhân, không gán thành regression hoặc PASS.
- Fallback `--webpack` có trong trợ giúp CLI cài tại worktree: **PASS, exit 0**.
  Compile 16.2s, TypeScript 2.9s, tạo 61/61 static pages; build trace hoàn tất.
- Cảnh báo Edge Runtime deprecated/static-generation vẫn có; không sửa runtime
  hoặc cấu hình dự án ngoài phạm vi QA. Không deploy output này.
- Đây là build local với cấu hình giả, không phải chứng nhận hosted/Production.

### Các cổng nghiệm thu còn mở

1. Isolated, reachable QA callback with signed terminal receipt projection.
2. SMS provider acceptance, scheduled 24h/3h and opt-out end-to-end within
   separately approved recipient/send scope.
3. Inbox placement and physical/new-user acceptance where required.

The one-email authorization is exhausted. Do not send again or relax Preview
protection merely to close the checklist. Overall P1-01 remains NOT COMPLETE.
