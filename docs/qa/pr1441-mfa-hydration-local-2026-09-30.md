# PR #1441 — MFA readiness: bằng chứng local trước/sau

Ngày 30/09/2026 Vancouver. Base detached `87ba36f5b53af0550f84ededcbc38b2a27263bd1`.
Worktree `/private/tmp/nailiq-pr1441-cli-verify-s8PKi5`. Chưa commit/push/Preview.
Không thay Auth, Supabase, policy, role, database, salon, WAF hoặc provider.

## Lỗi và mức chứng minh

CI `36689454836`, attempt 1: job Superadmin MFA status browser FAIL,
131 PASS/1 FAIL. Ảnh của ca expired-session WebKit cho thấy sáu ký tự trong
textbox nhưng Verify disabled, aria-busy false. Artifact CI được giữ riêng tại
`/private/tmp/nailiq-pr1441-mfa-artifact-9qVdD9`; không xóa bằng chứng FAIL.

Diagnostic local trước lượt này tái hiện nhập trước hydration: DOM chứa mã
nhưng React controlled state vẫn rỗng. Lượt này thêm regression công khai DOM,
giữ các JS chunk chưa tải, không dùng private React API hoặc sleep để đồng bộ.
Chạy trước khi sửa component: **1 FAIL**, đúng assertion input phải disabled
nhưng thực tế enabled. JSON giữ tại
`qa/mfa-status/test-results/mfa-hydration-before-fix.json`.

Đây là một cơ chế lỗi local đã chứng minh phù hợp với ảnh CI. Không có trace
timeline CI đầy đủ nên chưa khẳng định đó là nguyên nhân duy nhất của lần CI
thất bại. Không tăng timeout, rerun CI hoặc bỏ assertion để che lỗi.

## Bản sửa nhỏ, không nới bảo mật

- `src/components/superadmin/MfaChallengeForm.tsx`: snapshot server/initial
  hydration đều false; chỉ mở nhập và submit sau khi component sẵn sàng.
  Reuse cách `useSyncExternalStore` đã có trong repository. Giữ nguyên mã sáu
  số, in-flight guard, pending guard, action và xử lý session expired.
- Khôi phục focus sau readiness chỉ nếu focus còn ở body; không lấy focus
  khỏi thao tác người dùng. Không đổi layout, màu, primitive hoặc copy.
- `qa/mfa-status/challenge.spec.ts`: giữ JS, kiểm tra input/nút disabled,
  action count 0; mở JS, kiểm tra focus, nhập và Enter, đúng một stub action,
  không page error/hydration warning/request ngoài fixture.
- `qa/mfa-status/README.md`: số case thực tế 135, gồm 30 challenge checks.

Cách khóa control trước hydration phù hợp [hướng dẫn Playwright](https://playwright.dev/docs/navigations#hydration).
Snapshot SSR/initial hydration tuân thủ [React useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore#adding-support-for-server-rendering).
Skill Next.js ảnh hưởng cách sửa: giữ initial render khớp SSR, không thay
server action thành client auth hoặc bỏ render server.

## Lệnh và kết quả sau sửa

Các lệnh chạy bằng `env -i PATH="$PATH"`; không kế thừa credential.
Build/fixture dùng `NEXT_TELEMETRY_DISABLED=1`,
`DISABLE_OUTBOUND_SMS=1 DISABLE_OUTBOUND_EMAIL=1 DISABLE_OUTBOUND_CALLS=1
DISABLE_OUTBOUND_PAYMENTS=1 DISABLE_PAYMENT_PROVIDER=1`.
Default build thêm URL `https://example.supabase.co` và key `dummy`.

| Lệnh | Kết quả thật |
|---|---|
| `npm run typecheck` trước build | PASS, exit 0 |
| `npx --no-install eslint src/components/superadmin/MfaChallengeForm.tsx qa/mfa-status/challenge.spec.ts` | PASS, exit 0 |
| `npx --no-install next build qa/mfa-status --webpack` | PASS, 6/6 pages |
| `npx --no-install playwright test -c qa/mfa-status/playwright.config.ts -g "challenge stays inert until hydration\|expired session offers"` | 6/6 PASS, retries 0, 4.2s |
| `npx --no-install playwright test -c qa/mfa-status/playwright.config.ts` | 135/135 PASS, retries 0, 1.1m |
| `NODE_ENV=test npm run test:unit` | 878 files PASS/7 skipped; 7.245 tests PASS/79 skipped, 22.10s |
| `npm run build` với fake URL/key và kênh gửi OFF | default Turbopack 16.3.4 PASS, 61/61 pages; compile 2.7s/TypeScript 3.7s |

JSON focused/full giữ riêng dưới `qa/mfa-status/test-results/`; chỉ dữ liệu
fixture giả, không phải credential hoặc PII. Không publish generated artifacts
hoặc diagnostic private-props. Các log “private Auth detail” là lỗi stub cố ý
được test, không phải Auth thật; UI không lộ các nội dung đó. Edge Runtime
deprecation warning vẫn còn, không sửa ngoài phạm vi.

## CI/Cloud/Production không trộn với local

- Đọc lại GitHub: PR OPEN/Draft, head vẫn `87ba36f5`. CI tổng vẫn FAIL do MFA.
- E2E run riêng `36689454814` đã **SUCCESS**, attempt 1, đúng head; 10 jobs
  SUCCESS/2 SKIPPED. MQA-0148 và AI Triage skipped, không tính PASS.
- Tác vụ Cloud `task_e_6abcbe46d1a08332b65d61f81225f524` READY, +56/-3,
  ba files. Phần Cloud/cohort đã được bàn giao trước; không tạo trùng. READY
  là kết quả task, không phải Master Plan hay Production readiness.
- Hotfix này chưa có trên head remote, chưa CI/hosted Preview/release proof.
- Không thay Production hoặc hai salon Live, không gọi Auth/provider thật,
  không gửi SMS/email, không tạo booking và không có migration.
- MFA fixture thay toàn bộ action bằng stub: đây là component recovery proof,
  không chứng nhận real TOTP/MFA enforcement hoặc iPhone vật lý.
- Human pilot 7–14 ngày ở hai Hi-Lite, terminal provider/callback và quyết
  định thanh toán/activation vẫn chưa đủ chứng cứ; Master Plan NOT PROVEN.

**Kết luận:** hotfix MFA PASS local; CI đã publish vẫn FAIL; chưa hoàn tất
Master Plan. Bước publish cần phê duyệt riêng, không tự merge/deploy.

Whitelist bàn giao: component, challenge regression, fixture README, report
này và checkpoint nghiệm thu; CLI test/report thuộc batch local đã có trước
được giữ nguyên. Không stage toàn worktree, diagnostic, test-results hoặc
`error.log` ở checkout cũ.

## Kiểm tra tiếp nối — focus và JavaScript tắt, cùng ngày 30/09

Bổ sung hai regression vào fixture, không sửa thêm code sản phẩm:

- Giữ JS chưa tải; đặt focus vào một button synthetic ngoài form trước
  hydration; sau readiness, input enabled nhưng focus người dùng giữ nguyên.
- Tắt JavaScript trong browser context; HTML server hiển thị form với input
  và Verify disabled, không có action xác thực chưa được xử lý.

Cả hai dùng action stub và guard chặn request ngoài fixture; action count 0.
Đây là browser QA local theo hướng dẫn browser skill, dùng Playwright sẵn có
do CLI agent-browser chưa cài; không chứng nhận phiên đăng nhập hosted thật.

| Lệnh tiếp nối | Kết quả thật |
|---|---|
| `npx --no-install playwright test -c qa/mfa-status/playwright.config.ts -g "existing keyboard focus\|without JavaScript" --output=test-results/mfa-focus-noscript-artifacts` | 6/6 PASS, 3.4s |
| `npx --no-install playwright test -c qa/mfa-status/playwright.config.ts --output=test-results/mfa-edge-cases-full-artifacts` | 141/141 PASS, retries 0, 1.1m |
| `npm run typecheck` | PASS, exit 0 |
| `npx --no-install eslint src/components/superadmin/MfaChallengeForm.tsx qa/mfa-status/challenge.spec.ts` | PASS, exit 0 |

JSON mới: `qa/mfa-status/test-results/mfa-hydration-focus-noscript-focused.json`
và `qa/mfa-status/test-results/mfa-edge-cases-full.json`; giữ báo cáo đỏ và
lượt 135 trước đó, không ghi đè. README hiện 141 checks/36 challenge checks.
Unit/build của bản sửa sản phẩm là lượt đã ghi ở trên; không gọi đó là lần
chạy mới sau hai thay đổi test-only. Chưa commit/push hoặc redeploy Preview;
chưa nhận phê duyệt publish batch local. Giữ PR Draft và không thay Production.

## Checkpoint đóng gói sau phê duyệt — 30/09/2026 Vancouver

Huy đã duyệt publish batch vào PR #1441 và redeploy Preview QA, không Production.
Các câu chưa nhận phê duyệt ở trên là checkpoint trước đó, được giữ để truy vết.
Đọc lại remote/GitHub: head vẫn `87ba36f5`, OPEN/Draft; main `362dca4d`.
Lượt focused CLI/pilot mới: 49/49 PASS, 1.37s, exit 0, không credential.
Đọc JSON browser đã lưu: 141 expected, 0 unexpected, 0 flaky, 0 skipped;
đây là xác minh artifact, không phải một lần chạy browser mới.

Commit chỉ whitelist bảy file: component, browser tests, README, hai báo cáo,
CLI tests và bảng nghiệm thu. Không stage diagnostic hoặc generated results.
Push/redeploy vẫn chưa thực hiện: target branch chưa có env QA riêng và API
không trả giá trị secret để kiểm chứng DB; các biến mặc định có scope dùng
chung Production/Preview. Điều đó không chứng minh đích DB Production, nhưng
chưa đủ để coi Preview an toàn. Quyền sao chép kín cấu hình QA và bật kill
switch cho riêng branch đã được hỏi, chưa được xác nhận. Không dùng credential
Production, không đổi cấu hình hoặc tự kích hoạt deployment khi chưa an toàn.

Không coi commit local là CI PASS, Preview verification hoặc Master Plan PASS.
