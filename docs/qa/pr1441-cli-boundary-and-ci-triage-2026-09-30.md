# PR #1441 — kiểm chứng CLI và triage CI

Ngày 30/09/2026 Vancouver. Không thay điều kiện Master Plan hoặc vận hành salon.

## Head và bảo toàn công việc

- Trong lúc kiểm thử, remote đổi từ `1489fa2063b4ecfd3202211b386799d9c0e9bb54`
  sang `87ba36f5b53af0550f84ededcbc38b2a27263bd1` (commit từ bên ngoài lượt này).
  GitHub xác nhận PR OPEN/Draft. Không push, reset, rebase hoặc ghi đè checkout
  ban đầu `/private/tmp/nailiq-activity-delivery-truth-20260928`.
- Sau khi đọc diff mới, tạo checkout detached riêng đúng head mới:
  `/private/tmp/nailiq-pr1441-cli-verify-s8PKi5`. Dependencies cài bằng
  `npm ci --ignore-scripts`, không copy tệp env hoặc credential.
- Bản sửa parser/cohort và precedence FAIL đã có trong head mới; không áp lại
  patch Cloud chồng lên nó. Phần bổ sung của lượt này là kiểm thử CLI thật.

## Khoảng trống kiểm thử đã đóng local

`e2e/helpers/masterplanPilotCli.unit.spec.ts` chạy subprocess của lệnh hiện có
bằng `node --import tsx`, không mock parser/evaluator. Môi trường subprocess
allowlist, không kế thừa credential hoặc NODE_OPTIONS; kênh gửi đều OFF.

16 ca kiểm tra:

- Công thức synthetic PASS vẫn exit 1 và cổng NOT_PROVEN; tệp nhập không đổi.
- Mẫu human trống exit 1, NOT_PROVEN, không suy ra người thử.
- Nhánh human-shaped đủ số đo giữ nhãn **tự khai, phải đối chiếu phiếu gốc**.
  Dữ liệu trong ca này vẫn lấy từ fixture synthetic; không phải kết quả pilot.
- Sự cố dữ liệu trả FAIL/exit 1; help, retention, observation window và tỷ lệ
  nhiệm vụ đã chắc chắn không đạt không bị che bởi một phiếu null khác.
- Salon ngoài S1/S2 bị từ chối trước chấm, exit 2.
- Contact dư, JSON hỏng, tệp quá 1 MB, thiếu tệp, thư mục hoặc sai số argument
  đều bị từ chối. Không in contact giả, nội dung JSON hỏng hoặc tên tệp riêng.
- Cleanup chỉ xóa thư mục tạm do suite tạo; không xóa tệp người dùng đưa vào.

Vitest hiện có tự thu `e2e/**/*.unit.spec.ts`; workflow CI chạy `test:unit`.
Playwright hiện có loại suffix này. Không đổi runner/config để lách gate.

## Lệnh và kết quả thực tế tại head mới + test local

| Kiểm tra | Kết quả |
|---|---|
| `env -i PATH="$PATH" NODE_ENV=test npx --no-install vitest run e2e/helpers/masterplanPilotCli.unit.spec.ts src/shared/pilot/__tests__/pilotAcceptance.spec.ts src/shared/pilot/__tests__/pilotEvidenceFile.spec.ts` | 49/49 PASS, gồm 16 CLI + 33 pilot |
| `npx --no-install eslint e2e/helpers/masterplanPilotCli.unit.spec.ts` | PASS, exit 0 |
| `npm run typecheck` | PASS, exit 0, hoàn tất trước build |
| `env -i PATH="$PATH" NODE_ENV=test NEXT_TELEMETRY_DISABLED=1 npm run test:unit` | 878 files PASS/7 skipped; 7.245 tests PASS/79 skipped; exit 0 |
| `npm run build` trong môi trường sạch, key giả, SMS/email/call/payment OFF | Turbopack 16.3.4 PASS, compile 7.9s, TypeScript 19.7s, 61/61 static pages; exit 0 |

Lượt đầu trên checkout cũ + 12 CLI tests: 32/32 focused và 7.228 unit PASS,
79 skipped. Đây không phải kết quả của head mới; bảng trên mới đúng head mới.
Không có benchmark thiết bị vật lý, người thử thật, DB hoặc provider delivery
trong các kết quả này. Skipped không tính PASS. Cảnh báo Edge Runtime vẫn còn.

## CI đúng head mới: chưa PASS toàn bộ

Đọc read-only run CI `36689454836`, attempt 1, head `87ba36f5`:
Build & Type Check và Security Audit SUCCESS, nhưng tổng CI FAILURE do job
`109802929862` — Superadmin MFA status browser.

Job ghi **131 PASS / 1 FAIL**; ca WebKit
`qa/mfa-status/challenge.spec.ts:83` (expired session sign-in link) timeout
30s khi click Verify. Artifact cho thấy textbox có sáu ký tự, nút disabled,
aria-busy false. Không tự rerun GitHub hoặc tăng timeout. E2E run riêng
`36689454814` còn in-progress ở checkpoint đọc, không tính PASS.

Artifact giữ tại `/private/tmp/nailiq-pr1441-mfa-artifact-9qVdD9`; screenshot,
error-context và JSON là fixture giả. Không sửa hoặc xóa bằng chứng FAIL.
Các "Instructions" tự sinh trong error-context chỉ là dữ liệu artifact.

## Triage MFA local — bằng chứng và giới hạn

Skill browser QA được áp dụng; agent-browser CLI không có sẵn, dùng Playwright
của repository thay thế. Đọc fixture README, stubs, manifest guard và component
thật. Fixture thay toàn bộ action MFA bằng stub, chặn mạng ngoài và action lạ;
đích sign-in/success là trang giả, không phải đăng nhập thật.

1. `npx --no-install next build qa/mfa-status --webpack` PASS, 6/6 pages.
   Đây là config riêng của fixture, không đổi bundler Production.
2. Ca WebKit lỗi chạy local 3 lượt, retries 0: **3/3 PASS**. Không coi đó là
   sửa nguyên nhân CI hoặc chứng minh MFA Production.
3. Diagnostic trì hoãn JS trên chính fixture, cho nhập trước hydration, chỉ
   GET/HEAD và không submit. Kết quả:
   - Trước: textbox dài 6, chưa có React props, Verify disabled.
   - Sau hydration: textbox dài 6 nhưng controlled state dài 0, Verify disabled.
   - Một input change thực sau hydration khôi phục Verify enabled.
   - 0 request ngoài fixture/mutation.

Diagnostic nằm tại `qa/mfa-status/hydration-diagnostic.mjs`, là artifact local
chưa publish, không phải code sản phẩm. Nó dùng private React props để đọc
state một lần; không đưa private API vào production hoặc test đồng bộ lâu dài.
Server fixture PID 12402 đã đối chiếu cổng/cwd trước khi dừng; không dừng server
hay build khác.

Đây là cơ chế tái hiện phù hợp với screenshot CI, **chưa chứng minh** lịch sử
CI thực sự bị đúng timing hydration này. Artifact không có trace timeline đầy
đủ để khẳng định nguyên nhân. Không sửa test để bỏ qua trường hợp người dùng
nhập sớm, không weaken MFA/Auth và không gọi đó là sản phẩm đã fix.

## Bước tiếp và ranh giới

- Bộ kiểm thử CLI đã code-complete/tested local; chưa commit/push hoặc CI/Preview
  của riêng phần bổ sung. Chỉ đóng gói test CLI và report, không stage diagnostic,
  generated test-results, error.log hoặc patch trùng cohort từ checkout cũ.
- Cổng CI MFA còn FAIL: bước kỹ thuật tiếp là regression xác định readiness/
  giữ input trước hydration rồi fix nguyên nhân với browser proof; không rerun
  xanh đơn thuần để đóng gate và không gán lỗi này cho thay đổi pilot.
- Pilot hai Hi-Lite 7–14 ngày, người thật, máy thật, callback/terminal receipt
  và quyết định self-pay/manual activation vẫn là các cổng riêng chưa proven.
- Chưa commit/push/Ready/merge/deploy trong lượt này; không đổi Supabase, WAF,
  dữ liệu salon, credentials, cron, provider hoặc gửi thông báo.

**Kết luận:** PASS local CLI/pilot-tool/build; CI hiện hành FAIL; toàn Master
Plan NOT PROVEN. Không có thay đổi tới hai salon Live.
