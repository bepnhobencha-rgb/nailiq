# Waitlist Invite — Server pipeline acceptance, 24/09/2026

## Phê duyệt publish — checkpoint mới

Huy đã duyệt commit/push và tạo PR/Preview ở lượt tiếp theo. Branch:
`fix/waitlist-invite-identity-20260924`. Thêm đúng nhánh này vào
`vercel.json` deploymentEnabled=false để không tự deploy trước khi cấu hình
QA riêng được xác minh. Không đổi khóa `main` hay nhánh khác. Sau khi cấu
hình QA/provider OFF và kiểm chứng mới manual deploy Preview. Chưa được
phê duyệt merge/deploy Production, gửi thông báo hay migration.

Các câu “chưa commit/push” bên dưới ghi nhận mốc local trước phê duyệt;
trạng thái PR/CI/Preview sau publish phải xem receipt mới, không suy diễn PASS.

## Phạm vi và trạng thái

**Local implementation + local test evidence. Không phải hosted QA hoặc Production proof.**

- Mục gần nhất: P1-01 / V1-22 / V1-23, hành động “Mời lại” của tiếp tân.
- Base: `15caa385fcd6357b1ff3b8ed02ef432d73c17296`, detached HEAD.
- Worktree: `/private/tmp/nailiq-waitlist-server-qa-20260924`.
- Worktree cũ `/private/tmp/nailiq-day5-receptionist-20260924` và tài liệu đang
  sửa dở được giữ nguyên. Không dùng bản thân migration file làm bằng chứng
  schema Production.
- Không tạo migration, không truy cập database/provider, không gửi thông báo,
  không tạo booking, không commit/push/merge/deploy trong lượt này.

## Có sẵn trước lượt này

Action `inviteWaitlistEntry` xác minh context và role, lấy entry theo đồng thời
salon ID + entry ID, chỉ xử lý individual waiting/notified. Delivery dùng exact
capability/epoch, claim một lần mỗi kênh, và projection riêng cho trạng thái gửi.
Delivery material đã có guard đối chiếu identity với promotion.

SQL source `20260820143000_add_action_scoped_waitlist_claim_capabilities.sql`
lọc salon/entry, khóa hàng và trả ID theo input. Vì thế lỗi dưới đây là một
contract gap phòng thủ nhiều lớp, không phải chứng cứ SQL hiện tại trả sai ID.

## Tái hiện và sửa

Inject RPC response hợp lệ về cấu trúc nhưng sai salon hoặc entry. Trước sửa,
action vẫn trả `ok: true` (delivery unavailable ở fixture) thay vì chặn promotion
trước khi tải delivery material. Bộ mới lúc đó: **30 PASS, 2 FAIL**.

`promoteAndDeliverSpecificWaitlistEntry` giờ parse rồi đối chiếu cả hai UUID
với input đã được cấp quyền. Lệch identity trả `invalid_waitlist_response`
ngay, không tải material/claim/dispatch/truth. So sánh giữ tương thích UUID
khác casing/khoảng trắng vốn đã được input validator chấp nhận.

Không thay entrypoint cho booking cancellation hoặc advancement cron, không
thay request window, policy, role, consent, idempotency hoặc SQL.

## Coverage mới — 40 tests

Real action → real promotion helper → real delivery → real safe projection.
Auth resolver, DB query/RPC persistence và provider adapters là in-memory doubles.
Global fetch trong suite mới ném lỗi; assertions xác nhận không gọi fetch/email.

- Context thiếu/role không được phép chặn trước service-role access.
- Owner/admin/senior/receptionist đúng salon và selected entry; input sai,
  missing/read error, terminal/review status, group/sequence/unknown kind.
- Promotion typed failure, RPC error, no waiter, lỗi có PII được làm sạch;
  wrong salon/entry, epoch sai và UUID normalization.
- Already-notified retry với STOP/opt-out vẫn suppressed, không gửi mock lần hai.
- Hai action đồng thời chỉ hoàn tất một in-memory lease mỗi kênh.
  **Không gọi đây là SQL race proof.**
- Thiếu contact không claim/không báo đã giao; đọc receipt lỗi → unavailable.
- Truth đúng epoch/entry, bỏ contact/capability/provider receipt khỏi response.

## Lệnh kiểm chứng và kết quả

Chạy ở worktree trên, không nạp `.env` hoặc credential. `npm ci --ignore-scripts
--no-audit --no-fund` PASS (452 packages).

```sh
env -i PATH="$PATH" HOME="$HOME" NODE_ENV=test DISABLE_OUTBOUND_SMS=1 DISABLE_OUTBOUND_EMAIL=1 DISABLE_OUTBOUND_CALLS=1 ./node_modules/.bin/vitest run src/shared/dashboard/__tests__/waitlistInvitePipeline.spec.ts src/shared/noshow/__tests__ src/shared/security/__tests__/waitlistOfferCallsites.spec.ts src/shared/security/__tests__/waitlistTerminalDeliveryTruthBoundary.spec.ts
env -i PATH="$PATH" HOME="$HOME" ./node_modules/.bin/eslint src/shared/noshow/promoteAndDeliverWaitlistOffer.ts src/shared/dashboard/__tests__/waitlistInvitePipeline.spec.ts
env -i PATH="$PATH" HOME="$HOME" ./node_modules/.bin/tsc --noEmit
env -i PATH="$PATH" HOME="$HOME" NODE_ENV=test ./node_modules/.bin/vitest run --reporter=dot
env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_SUPABASE_URL=https://qa.invalid NEXT_PUBLIC_SUPABASE_ANON_KEY=synthetic-build-only NEXT_PUBLIC_SITE_URL=http://localhost:3000 DISABLE_OUTBOUND_SMS=1 DISABLE_OUTBOUND_EMAIL=1 DISABLE_OUTBOUND_CALLS=1 ./node_modules/.bin/next build --webpack
env -i PATH="$PATH" HOME="$HOME" ./node_modules/.bin/tsc --noEmit
git diff --check
```

- Focused: **314/314 PASS, 26 files** (40 new pipeline tests).
- Touched-file ESLint: **PASS**.
- Typecheck trước build: **PASS**.
- Full suite: **6.717 PASS, 65 skipped; 853 files PASS, 6 skipped**.
- Lượt full đầu có 10 FAIL: 4 localhost transport test bị sandbox EPERM,
  6 mock-provider assertions bị env kill switch toàn cục làm lệch expected path.
  Đã đọc các tests trước khi chạy lại: email/Twilio adapters được mock, localhost
  cleanup dùng HTTP server giả. Rerun với env trống, quyền localhost: PASS,
  không chỉnh tests cũ để lấy PASS. Vite CJS/ESM config warning còn tồn tại.
- Next webpack build: **PASS**, compile 23,1 giây, 61/61 static pages; chỉ dùng
  placeholder build URL/key, không nạp Supabase credential.
- Typecheck sau build và diff check: **PASS**. Đã review patch: chỉ helper
  selected-entry thêm guard; test và tài liệu; không thay migration/UI/policy.

**Kết luận: PASS ở phạm vi local hardening và regression test; NOT PROVEN ở
hosted QA, Production và toàn bộ P1-01.**

Logs local:
`/private/tmp/nailiq-waitlist-20260924-unit.log` (lượt đầu),
`/private/tmp/nailiq-waitlist-20260924-unit-clean-env.log` (rerun),
`/private/tmp/nailiq-waitlist-20260924-build.log` (build).

## Giới hạn và bước phát hành

- Không chạy browser mới trong lượt server-only này. UI acceptance trước đó
  không tự động biến thành hosted acceptance của guard mới.
- Không chứng minh real Auth/RLS, SQL transaction/race/retry, receipt persistence
  qua reload, terminal callback/provider delivery, inbox hoặc iPhone vật lý.
- Không có bằng chứng sự cố sai salon/entry xảy ra tại Production.
- P1-01/V1-22/V1-23 và toàn Master Plan **chưa được đóng** bởi số test xanh.
- Bước phát hành cần phê duyệt riêng commit/push/PR/Preview guard này; sau đó
  hosted QA synthetic với provider OFF. Không dùng approval gửi email cũ để gửi thêm.
- Rollback: bỏ riêng guard ở application helper nếu cần khôi phục bản trước;
  không có schema/data rollback. Khi chưa publish, giữ patch để review, không
  reset/xóa worktree hay thay đổi file khác của người dùng.
