# Waitlist claim — nghiệm thu reload trên Chromium/WebKit

Checkpoint B55. **IMPLEMENTED_LOCALLY / TESTED_LOCALLY.**

## Kết luận

**PASS 44/44 browser tests, retries=0, skip=0, flaky=0** trên desktop
Chromium và WebKit mô phỏng iPhone SE, iPhone Pro Max, iPad. Mỗi project chạy
11 tình huống. **Ngày 22 vẫn NOT_CLOSED; Master Plan vẫn NOT_PROVEN.**

B55 chỉ bổ sung fixture và regression; không sửa code sản phẩm hoặc migration.
Fixture nhập `WaitlistClaimButton` và helper request-ID thật, chạy hydration,
keyboard, click, sessionStorage và reload trong browser thật. API được mock ở
ranh giới transport; bảng receipt trong test là mô phỏng, **không phải DB proof**.
Bằng chứng Chrome/Next/PostgreSQL local thật nằm riêng trong báo cáo B54.

## Phạm vi

- Claim chỉ POST khi người dùng bấm; mở/reload không POST.
- Phân biệt `booked` với `claimed`; không gọi reserved là booked.
- Mất response/503 → reload → recovery; mất lần nữa → reload → bấm lại dùng
  cùng request ID. Acknowledgement xóa replay metadata; reload không POST mới.
- 400/409 terminal giữ thông báo unavailable riêng tư, không recovery tiếp.
- Outcome không hợp lệ không thành Confirmed; retry giữ cùng intent.
- Double activation bị khóa đồng bộ; busy/disabled rõ ràng.
- Không có metadata hoặc metadata thuộc token khác không tạo intent mới cho
  offer unavailable. Storage denied fail closed, không POST.
- Recovery kiểm axe WCAG 2.0/2.1 A/AA, target ít nhất 44px, không tràn ngang và
  nút nằm trọn viewport; có screenshot riêng cho từng project.
- Page errors làm test thất bại. Mọi external request và mutation khác bị chặn
  và có assertion bằng 0. Không hosted/provider credentials, không database.

## File

1. `qa/waitlist-delivery/app/claim/page.tsx`
2. `qa/waitlist-delivery/claim.config.ts`
3. `qa/waitlist-delivery/tests/claim-recovery.spec.ts`
4. `qa/waitlist-delivery/README.md`

Fixture không tạo API route, không bypass rate/CSRF/Auth hay thay production
loader. Query `available=0` chỉ mô phỏng kết quả inspect; server inspection đã
kiểm riêng tại B54. Cấu hình CI hiện có chạy default delivery config, tự discover
spec mới trong hai projects; matrix bốn projects là kiểm local riêng, chưa CI.

## Kết quả và bằng chứng đỏ được giữ

Chạy từ `/private/tmp/nailiq-current-main-combined-iBPOnd/repo` bằng harness
whitelist environment và network guard chỉ cho loopback:

```text
node ../verify-b55.mjs build
  PASS: fixture Webpack build 4/4 pages.
node ../verify-b55.mjs browser
  BLOCKED: listen EPERM localhost; 0 bài thực thi, không gọi là PASS.
node ../verify-b55.mjs browser localhost-approved
  FAIL: 36 PASS / 8 FAIL / 0 SKIP, retries=0.
```

Tám bài đỏ đều dừng ở axe `document-title`: fixture mới thiếu title HTML.
Đã thêm metadata title vào chính fixture, không sửa component, không disable
axe rule và không coi đây là lỗi title của Production. JSON/log/trace đỏ giữ
nguyên trong `waitlist-claim-browser-b55-first-red/` trước lượt chạy mới.

```text
node ../verify-b55.mjs build title-corrected
node ../verify-b55.mjs browser title-corrected
  PASS: 44/44, retries=0, skip=0, flaky=0.
node ../verify-b55.mjs delivery
  PASS: 50/50 trong default delivery config (28 tests cũ + 22 claim),
  retries=0, skip=0, flaky=0. Phần claim overlap với matrix 44; không cộng
  44+50 thành 94 tình huống độc lập.
node ../verify-b55.mjs lint final
node ../verify-b55.mjs typecheck final
  PASS, exit 0; focused ESLint 0 errors/0 warnings.
git diff --check
git diff --cached --check
  PASS, exit 0.
```

Computer Use đã mở tab Chrome riêng tại fixture unavailable: trang có nội dung
riêng tư, không blank/overlay/nút claim. Không bấm mutation qua tab đó; tab QA
đã đóng, các tab của người dùng được giữ. Hai bộ Playwright tự dừng server
localhost sau test. Build ứng dụng/full unit B54 không chạy lại vì B55 không
thay sản phẩm; source B54 được đối chiếu hash để tránh lấy bằng chứng cũ cho
code khác.

## Trạng thái bên ngoài đọc lại trong lượt này

- Main: `362dca4d028b40e3bcce52f67fac40fbc9caf07e`.
- PR #1441: OPEN Draft, head `e2680aa7a779448940ba597317e908c503089a66`;
  checks kết thúc SUCCESS/SKIPPED, không pending/FAIL. **Không chứng nhận B54/B55.**
- PR #1439: OPEN Draft, head `680150f3f96033732b18b70c8810ad786dc80468`.
- Candidate detached HEAD giữ nguyên; bốn file đã staged trước đó được giữ.

## Giới hạn và bước tiếp theo

WebKit/device emulation không phải iPhone/iPad vật lý hoặc người dùng thật.
API mocked không chứng minh hosted idempotency, provider delivery, scheduler,
RLS hay migration ACL/advisors. Không có booking hoặc tin thật trong lượt này.
Các gate pilot 7–14 ngày với đúng Hi-Lite Head Spa và Hi-Lite Studio vẫn cần
bằng chứng con người; không lấy test synthetic thay thế.

Bước publication phải review đúng batch local và được duyệt commit/push,
PR/Preview cùng môi trường QA. Không lấy CI head cũ chứng nhận patch mới;
không áp bốn migration local lên hosted hoặc Production bằng phê duyệt chung.

**Chưa commit/push/merge/deploy, không migration, không provider hoặc SMS/email;
hai salon Live không bị thay đổi.**
