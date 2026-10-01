# Waitlist claim — phục hồi sau mất phản hồi và reload

Checkpoint B54, 01/10/2026 Vancouver. **IMPLEMENTED_LOCALLY / TESTED_LOCALLY.**

## Kết luận

**PASS local cho lỗi phục hồi claim sau reload.** Đã dùng Computer Use trên
Chrome thật, ứng dụng Next thật và PostgreSQL/PostgREST local thật. Không mock
kết quả claim hoặc ghi booking/receipt bằng tay để làm xanh bài test.

**Day 22 vẫn NOT_CLOSED; Master Plan vẫn NOT_PROVEN.** Bản sửa chưa publish,
chưa CI/Preview hoặc Production-verified. Các gate người thử thật, thiết bị vật
lý, provider/scheduler và migration hosted không được thay bằng test local.

## Lỗi đã tái hiện và nguyên nhân

1. Khách bấm nhận chỗ; Next trả HTTP 200 sau khi PostgreSQL đã commit một
   booking và một durable claim receipt.
2. Proxy test local drain response rồi đóng socket trước khi trả header/body
   cho browser. UI báo thử lại; request ID cũ còn trong sessionStorage.
3. Reload gọi GET inspect, capability đã consumed. Page cũ render tĩnh
   `Slot unavailable` nên client không còn cơ hội đọc request chưa nhận kết quả.
4. Bằng chứng đỏ giữ nguyên: `waitlist-claim-ui-b54-case3-reload-failed.json`
   và `ui-claim-reload-fail-b54.png`. Retry không reload đã PASS trước sửa;
   không dùng điều đó che lỗi reload.

## Cách sửa

- Token có định dạng hợp lệ vẫn nhận client surface sau GET inspect không
  available. SSR giữ thông báo unavailable riêng tư, không tiết lộ lý do consumed,
  expired, unknown hoặc thông tin khách hàng. Token sai định dạng vẫn bị chặn.
- Sau hydration, chỉ đọc replay metadata của chính token/action trong browser.
  Nếu còn request ID chưa được acknowledged, hiện `Check previous claim`.
- Người dùng phải bấm rõ ràng để POST lại **đúng request ID cũ**. Không POST
  trên mount/reload, không booking bằng GET, không tạo request ID mới cho offer
  không available, không tự retry mutation khi mất mạng.
- Transport/503/JSON lỗi hoặc outcome không hợp lệ giữ request để thử lại.
  Chỉ `booked`/`claimed` hợp lệ mới hiển thị Confirmed. Terminal 400/409 vẫn
  fail closed và giữ response riêng tư.
- Ref khóa in-flight chặn kích hoạt liên tiếp; Button dùng primitive chung,
  trạng thái disabled/busy và kích thước 48px. Không thêm màu, spacing hoặc
  animation riêng; không sửa authentication, tenant, rate limit, CSRF hay RPC.

## File sản phẩm và regression thay đổi trong checkpoint này

1. `src/app/booking/waitlist-claim/page.tsx`
2. `src/app/booking/waitlist-claim/WaitlistClaimButton.tsx`
3. `src/shared/booking/waitlistClaimRecovery.ts`
4. `src/shared/booking/__tests__/waitlistClaimRecovery.spec.ts`
5. `src/app/booking/waitlist-claim/WaitlistClaimButton.spec.ts`
6. `src/shared/security/__tests__/waitlistClaimExposure.spec.ts`
7. `src/shared/security/__tests__/bookingManagementRuntimeAcceptance.spec.ts`

Helper/unit tests kiểm request lifecycle; component unit dùng hook harness
Node, không được gọi là browser hydration test. Source contracts vẫn giữ gate
stable ID nhưng theo helper mới; không dùng comment để thỏa assertion.
Hydration, keyboard, POST và database được kiểm riêng qua Computer Use bên dưới.

## Các tình huống UI/HTTP/DB đã kiểm

| Tình huống | UI và database | Kết quả |
|---|---|---|
| Mất phản hồi sau commit, Retry không reload | Confirmed; hai POST cùng hash ID; một booking/một receipt | PASS local |
| Mất phản hồi rồi reload trước sửa | Slot unavailable, không có recovery; một booking/một receipt | FAIL giữ nguyên |
| Reload cùng trường hợp sau sửa | Có Check previous claim; reload không thêm POST; bấm nút trả Confirmed | PASS local |
| Lượt mới sau sửa: commit → mất response → reload | Giữ hash ID cũ; không POST tự động | PASS local |
| Mất response thêm lần nữa khi recovery, rồi Retry | Ba POST cùng hash ID; vẫn một booking/một receipt, Confirmed | PASS local |
| Reload sau acknowledgement | Không recovery/POST mới; offer consumed giữ thông báo chung | PASS local |
| Token unknown, không có replay metadata | Thông báo unavailable, không claim/recovery/POST | PASS local |
| Lượt nhận chỗ bình thường trên code cuối | Confirmed, một POST/một booking/một receipt | PASS local |

Final checkpoint có bốn entry claimed, mỗi entry đúng một booking và một
receipt; một entry test cũ còn notified, không booking/receipt. Tổng **8 POST**,
bốn request-ID hash độc lập; **4 response HTTP 200 bị ngắt** có kiểm soát.
Không SMS attempts, không notification rows, không auth users, không deadlock.
Không coi fixture còn notified là một bài test đã PASS.

## Lệnh và kết quả thật

Chạy từ `/private/tmp/nailiq-current-main-combined-iBPOnd/repo`:

```text
npx vitest run src/app/booking/waitlist-claim/WaitlistClaimButton.spec.ts \
  src/shared/booking/__tests__/waitlistClaimRecovery.spec.ts \
  src/shared/booking/__tests__/bookingManagementRequestId.spec.ts \
  src/shared/security/__tests__/waitlistClaimExposure.spec.ts \
  src/shared/security/__tests__/bookingManagementRuntimeAcceptance.spec.ts \
  src/app/api/booking/waitlist-claim/route.spec.ts
  PASS 61/61 trước khi bổ sung unknown-outcome; test bổ sung nằm trong full run.

node /private/tmp/nailiq-current-main-combined-iBPOnd/verify-b54.mjs unit
  FAIL: 7385 PASS / 37 FAIL / 227 SKIP; giữ JSON/log đỏ.

node /private/tmp/nailiq-current-main-combined-iBPOnd/verify-b54.mjs unit calibrated
  PASS: 7422 PASS / 0 FAIL / 227 SKIP / 7649 tổng.

node /private/tmp/nailiq-current-main-combined-iBPOnd/verify-b54.mjs typecheck
node /private/tmp/nailiq-current-main-combined-iBPOnd/verify-b54.mjs lint
node /private/tmp/nailiq-current-main-combined-iBPOnd/build-b53.mjs build b54
node /private/tmp/nailiq-current-main-combined-iBPOnd/verify-b54.mjs post-typecheck
  Tuần tự, exit 0. Next 16.3.8 default Turbopack build 61/61 pages.
  Focused lint không lỗi/cảnh báo. Build còn cảnh báo Edge Runtime deprecated.

git diff --check
git diff --cached --check
  exit 0.
```

Lượt unit đỏ do harness, không phải đã chứng minh regression sản phẩm:

- 16 tests mở HTTP fixture loopback bị sandbox từ chối `listen EPERM`.
- 21 tests mocked card capture bị global `NAILIQ_CARD_SAVE_DISPATCH_DISABLED`
  ép vào nhánh paused ngoài mục tiêu test. Đọc rõ provider/RPC mocks trước
  khi bỏ riêng override này **chỉ trong process unit**, không sửa source test.
- Lượt calibrated được cấp quyền localhost; vẫn chặn network ngoài ở tầng
  transport và không có hosted/provider credential. Harness UI/build giữ toàn
  bộ kill switches. Không thay switch Vercel/Production để làm xanh tests.
- 227 SKIP gồm integration tests có guard riêng; không tính là PASS. 103 DB
  integration PASS ở B53 là bằng chứng trước đó, không phải rerun trong B54.

## Cô lập và bảo toàn công việc

- Candidate detached HEAD `e2680aa7a779448940ba597317e908c503089a66`.
  Main/PR remote chỉ là snapshot đã đọc ở checkpoint trước, không kiểm chứng
  hoặc publish mới trong checkpoint này.
- Clone `nailiq_inbound_atomic_20260930_b54` thuộc test synthetic riêng,
  schema-only; không sao chép dữ liệu salon Live. Fixture giữ lại làm bằng chứng.
- Root database local trước/sau UI và build vẫn 0 salons/users/bookings/profiles.
- App/proxy/gateway và container PostgREST riêng B54 đã dừng; tab QA do agent
  tạo đã đóng. Không dừng stack hoặc tab người dùng đang dùng cho tác vụ khác.
- Baseline 46 source fingerprints: 45 không đổi; một integration spec đã đổi
  ở B52/B53 trước checkpoint này. Các file mới/sửa B54 được ghi hash riêng.
- Bốn file staged PR1439, toàn bộ changes khác và bốn migration local hiện có
  được giữ nguyên. **Không tạo/sửa migration trong B54.**

## Giới hạn và bước kế tiếp

- Recovery chỉ có metadata trong cùng browser session, theo TTL 24h hiện có.
  Mất/xóa storage hoặc dùng thiết bị khác không được tự mint một claim mới.
- Trước hydration, SSR vẫn hiện thông báo unavailable chung; không cung cấp
  claim mới khi JavaScript chưa chạy. Sau acknowledgement, reload không phải
  một booking-history page; khách dùng thông tin xác nhận/luồng liên hệ salon.
- Chrome desktop/local PASS không chứng minh iPhone vật lý, WebKit, hosted
  transport hay hành vi của khách/người thử thật. Nội dung page vẫn tiếng Anh
  theo surface hiện hữu; chưa làm localization EN/VI cho recovery trong batch này.
- Publish cần batch review đúng các file này cộng các engineering patch còn
  unpublished, CI/Preview QA mới và hosted schema/ACL/advisors rehearsal theo
  phê duyệt riêng. Không lấy CI/Preview head cũ chứng nhận code mới.
- Rollback hotfix client là trả bảy file trên về snapshot trước B54 trong một
  batch review riêng; không chạm các changes khác. Không dùng feature flag OFF
  để tuyên bố đã rollback bốn function migrations dùng chung hiện còn local.

**Chưa commit, chưa push, chưa merge/deploy, chưa migration hosted, không gọi
provider hoặc gửi SMS/email, không thay đổi hai salon Live.**

Artifacts ở `/private/tmp/nailiq-current-main-combined-iBPOnd/`:
`waitlist-claim-ui-b54-case*-*.json/.log`, `verification-b54-*.json/.log`,
`default-build-b54.log`, ảnh UI đỏ/xanh và `combined-ui-recovery-evidence-b54.json`.
