# Waitlist — hướng dẫn đúng theo bằng chứng giao tin

## Phạm vi và trạng thái

- Kiểm tra ngày 23/09/2026 PDT (24/09 UTC).
- Baseline đã fetch: `origin/main` = `bd6fadfd552bcca490b41b67d7eb01c8309772be`.
- Branch local: `fix/waitlist-delivery-guidance-20260924`.
- Worktree cô lập: `/private/tmp/nailiq-waitlist-guidance-20260924`.
- **Implemented locally / Tested locally.** Đây là snapshot nghiệm thu trước khi phát hành; trạng thái CI/Preview mới nhất phải đối chiếu trên PR.
- Huy đã duyệt commit/push/tạo PR Preview qua phản hồi “N” sau báo cáo local. Giữ PR Draft, chưa được duyệt merge/Production.
- Không migration, không gọi provider, không gửi SMS/email, không tạo booking hay sửa salon thật.
- Worktree Auth PR #1422 giữ sạch, không trộn bản sửa này vào PR đó.

## Lỗi và nguyên nhân gốc

`OnlineWaitlistPanel` chọn lời hướng dẫn theo `status=notified` và loại yêu cầu,
không xét bằng chứng giao tin. Vì vậy SMS thất bại + email bị chặn vẫn hiện màu
xanh “NailIQ tự xử lý”, “đang chờ khách”. Badge từng kênh đúng nhưng phần hướng
dẫn mâu thuẫn. Lỗi được tái hiện bằng component thật trong fixture local; đây
không phải bằng chứng đã kiểm tra trực tiếp dữ liệu gửi của salon Production.

## Sửa tối thiểu

Thêm phép phân loại thuần túy, chỉ phục vụ hiển thị:

| Bằng chứng | Hướng dẫn |
| --- | --- |
| Ít nhất một kênh `delivered` | Đang chờ khách phản hồi; chưa phải booking. Giữ nguyên badge lỗi của kênh còn lại. |
| Cả hai kênh `failed` hoặc `suppressed` | Cần kiểm tra thông báo; tôn trọng opt-out, không tự gửi lại. |
| Chưa có `delivered`, có `pending`/`sending` | Thông báo đang được gửi; chưa xác nhận giao. |
| Các tổ hợp còn lại, kể cả `accepted`, `sent`, `unknown`, thiếu dữ liệu | Chưa xác nhận giao thông báo. |

Chỉ áp dụng khi classifier hiện có trả `customer_response_pending`. Không đổi
classifier vận hành, nút mời, luồng duyệt nhóm, claimed, worker, retry, opt-out,
ACL hay RLS. Không thêm state/effect React; suy ra hướng dẫn từ dữ liệu đang render.

## File thay đổi

- `src/shared/noshow/waitlistDeliveryGuidance.ts`
- `src/shared/noshow/__tests__/waitlistDeliveryGuidance.spec.ts`
- `src/components/receptionist/OnlineWaitlistPanel.tsx`
- `src/shared/i18n/user/en.ts`
- `src/shared/i18n/user/vi.ts`
- `qa/waitlist-delivery/app/page.tsx`
- `qa/waitlist-delivery/tests/delivery-status.spec.ts`
- Báo cáo này.

## Kết quả thật

| Gate | Kết quả |
| --- | --- |
| 21 bộ unit/regression liên quan | PASS: 216 tests, không skip |
| Helper mới | PASS: 84 tests, gồm 81 tổ hợp SMS/email và 3 trường hợp thiếu dữ liệu |
| ESLint 7 file mã nguồn/test đã sửa | PASS |
| `npm run typecheck` | PASS |
| `node --import tsx scripts/check-i18n.ts` | PASS: 0 lỗi; 13 cảnh báo ở các chuỗi ngoài phạm vi sửa |
| `next build qa/waitlist-delivery --webpack` | PASS |
| Playwright fixture | PASS: 4/4, EN/VI × Chromium desktop/WebKit iPhone 14, retries=0 |
| Computer Use | PASS local: đọc cả EN/VI, mở khách QA Failed, Escape trả focus, kiểm tra mobile 390×844 |
| `next build --webpack` toàn ứng dụng | PASS, biên dịch + TypeScript + tạo trang |
| `npm run build` mặc định Turbopack | NOT PROVEN: kẹt tại compile, đã chủ động dừng (130); không gọi đây là PASS |
| `git diff --check` | PASS |

Lần Playwright đầu sau khi bổ sung fixture bị lỗi bộ chọn trùng nhãn. Đã scope
bộ chọn về đúng hàng; chạy lại cả 4 case đều PASS. Lần đầu mở localhost bị sandbox
chặn; sau cấp quyền chạy localhost đã test thành công. Không có lỗi UI nào được
che bằng retry hoặc skip.

### Lệnh tái kiểm tra

Chạy từ worktree trên. Môi trường kiểm tra được xóa biến kế thừa bằng `env -i`;
chỉ giữ PATH/LANG và bật `DISABLE_OUTBOUND_SMS=1`, `DISABLE_OUTBOUND_EMAIL=1`,
`DISABLE_OUTBOUND_CALLS=1`, `DISABLE_PAYMENT_PROVIDER_CALLS=1`,
`DISABLE_OUTBOUND_PAYMENT=1`. Unit/full build dùng Supabase URL
`http://127.0.0.1:1` và placeholder key, không dùng secret thật.

```sh
npm run typecheck
node --import tsx scripts/check-i18n.ts
./node_modules/.bin/next build qa/waitlist-delivery --webpack
./node_modules/.bin/playwright test --config qa/waitlist-delivery/playwright.config.ts
./node_modules/.bin/next build --webpack
git diff --check
```

21 file cho `vitest run`:

```text
src/shared/noshow/__tests__/waitlistDeliveryGuidance.spec.ts
src/shared/booking/__tests__/capacityRescueAutonomy.spec.ts
src/shared/noshow/__tests__/deliverPromotedWaitlistOffer.spec.ts
src/shared/noshow/__tests__/waitlistDeliveryTruth.spec.ts
src/shared/noshow/__tests__/loadWaitlistDeliveryTruth.spec.ts
src/app/api/webhooks/resend/route.spec.ts
src/shared/booking/__tests__/bookingConfirmationDeliveryTruth.spec.ts
src/shared/reminders/__tests__/reminderDeliveryClaims.spec.ts
src/shared/reminders/__tests__/smsConsentSuppression.spec.ts
src/shared/reminders/__tests__/reminderScheduleDst.spec.ts
src/shared/notifications/__tests__/staffActionNotificationWorker.spec.ts
src/shared/notifications/__tests__/staffActionNotificationDelivery.spec.ts
src/shared/notifications/__tests__/ownerWaitlistNotificationWorker.spec.ts
src/shared/security/__tests__/waitlistTerminalDeliveryTruthBoundary.spec.ts
src/shared/security/__tests__/resendCustomerDeliveryTruthBoundary.spec.ts
src/shared/security/__tests__/resendOwnerDeliveryTruthBoundary.spec.ts
src/shared/security/__tests__/registeredEmailDeliveryTruthBoundary.spec.ts
src/shared/security/__tests__/reminderOutboundKillSwitchBoundary.spec.ts
src/shared/security/__tests__/staffActionNotificationSmsReplayAcceptance.spec.ts
src/shared/security/__tests__/bookingReminderDeliveryClaimBoundary.spec.ts
src/shared/security/__tests__/notificationSettingsReadBoundary.spec.ts
```

Fixture có 9 khách synthetic, không DB, không secret. Playwright chặn mọi request
ngoài origin localhost và mọi method ngoài GET/HEAD. Không bấm Mời lại, gọi điện
hoặc tạo booking trong Computer Use. Đã đóng tab, trả lại viewport và dừng server.

Artifacts: `test-results/waitlist-delivery/results.json` và ảnh EN/VI của mỗi
browser trong `test-results/waitlist-delivery/artifacts/` (không commit artifacts).

## Giới hạn / bước phát hành

- PASS bản sửa local theo phạm vi trên; chưa chứng minh toàn bộ Master Plan 100%.
- Chưa kiểm tra hosted Preview, tenant E2E hoặc Production của bản sửa này.
- Build Turbopack mặc định cần chạy lại trong CI/môi trường phù hợp; Webpack PASS
  không thay thế bằng chứng CI đó.
- Không chứng minh thư vào inbox hoặc khách đã đọc; `delivered` chỉ là bằng chứng
  giao tin hiện có mà loader cung cấp. Không thay đổi cách tải/đồng bộ dữ liệu.
- Commit/push/PR Preview đã được duyệt; merge/Production cần phê duyệt riêng.
- Rollback local: bỏ riêng changeset này nếu được yêu cầu; không có DB/schema hay
  cấu hình ngoài nào cần rollback. Không xóa thay đổi của worktree khác.
