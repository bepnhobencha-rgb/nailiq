# P0-03 — Tenant/role, quota và WAF runtime

Ngày kiểm tra ban đầu: 21/09/2026
Nhánh triển khai: `audit/p0-03-tenant-runtime-20260921`
Base triển khai: `bb2f866fa9d6a459637350a946868440ab5a05dd`
Production closeout: PR #1417, merge SHA
`7c5fad5bc9d52e24fcf852168b5d8184358b639e`

## Kết luận

**PRODUCTION DATABASE PASS — thời gian quan sát WAF vẫn là gate riêng.**

- **Tenant/role: PASS trong phạm vi hiện có.** CI real-auth gần nhất kiểm tra năm
  vai trò, cách ly hai tenant, thu hồi session, thu hồi membership và hạ quyền
  khi form đang mở. Bộ test local về permission/tenant cũng PASS.
- **Quota ứng dụng: PASS ở lớp durable limiter đã kiểm.** Public booking page,
  auth và public API đều đi qua quota lưu bền; public booking/API fail closed
  khi limiter không dùng được. Các endpoint nhạy cảm vẫn có bucket hẹp riêng.
- **Vercel WAF: PASS ở chế độ quan sát.** Firewall version 9 đang có đúng hai
  programmatic rate-limit rule ID mà runtime hiện gọi: `booking-page-load`
  60 request/60 giây/IP và `contact-submit` 5 request/3.600 giây/IP. Cả hai dùng
  follow-up action `log`, không deny/challenge/429. Rule stale-writer cũ vẫn giữ
  nguyên; không có draft hoặc system bypass.
- **Supabase Advisor Production: PASS điều kiện “không ERROR”.** Migration
  `20260921170000` đã được áp đúng phạm vi; Production hiện trả 0 ERROR và
  20 WARN đã biết/được quản lý riêng. Metadata, exact function signatures và ACL
  đã được kiểm chứng sau rollout.
- **QA disposable: PASS.** Project `nailiq-p0-03-qa-20260921`
  (`uhpzafoiifupyypkcwln`) đã nhận toàn bộ migration history cùng hotfix; remote
  migration list khớp local đến `20260921170000`.

Không có dữ liệu salon/khách Production bị thay đổi. Không gửi SMS/email/call,
không gọi payment provider. PR #1417 và migration P0-03 đã được rollout theo phê
duyệt cụ thể; WAF Production vẫn chỉ dùng hai rule quan sát log-only.

## Bằng chứng tenant và vai trò

CI của PR #1416 tại head `9ee677c11e4d971011cc4fd1cb65cc2625cd37cf`
có job **E2E (Playwright) — tenant roles and session revocation — real auth** ở
trạng thái SUCCESS. Harness `e2e/p0-tenant-auth.spec.ts` bao phủ:

- `owner`, `admin`, `senior`, `receptionist`, `nail_tech`;
- đọc/ghi cùng tenant và từ chối cross-tenant;
- settings RPC chỉ cho owner/admin;
- access token đã sign-out bị từ chối ở active-session RPC;
- xóa membership làm browser mất quyền sau reload;
- hạ admin thành nail tech trong lúc form sửa đang mở làm mutation bị từ chối,
  không đổi booking.

Local trên base hiện hành: **14 test files, 251/251 PASS**, gồm permission/
tenant, rate-limit, resource projection và SECURITY DEFINER allowlist. Tenant
browser acceptance vừa chạy lại trên Supabase local disposable: **18/18 PASS**
trên desktop Chromium và mobile WebKit, gồm năm vai trò, cách ly hai salon,
session revocation, membership removal và demotion EN/VI.

Đây là bằng chứng tự động, không thay thế pilot người thật.

## Bằng chứng Supabase Production read-only

Catalog metadata hiện hành:

- 241/241 public tables bật RLS;
- 0 public table tắt RLS;
- 221 policies trên 167 tables;
- anon đọc trực tiếp `salon_resources`: 0 row do RLS;
- anon đọc projection `public_booking_resource_catalog`: 14 row;
- projection chỉ có `id`, `salon_id`, `name`, `kind`, `display_order` và lọc
  resource/salon đang active, published, resource-enabled.

Security Advisor trước hotfix trả một ERROR `security_definer_view` cho
`public.public_booking_resource_catalog`. Sau rollout #1417, Advisor hiện trả:

- 0 ERROR;
- 1 WARN: `pg_net` còn ở schema `public`;
- 11 WARN cho anonymous SECURITY DEFINER function;
- 7 WARN cho authenticated SECURITY DEFINER function.

Các function cảnh báo không được tự động coi là lỗ hổng hoặc PASS: nhiều RPC là
public booking boundary có chủ ý và đã có allowlist/regression riêng, nhưng phải
giữ exact signature, input guard, tenant fence, search path và EXECUTE ACL.

### Migration parity

Production history có migration `20260908014241_fix_public_booking_resource_catalog`
nhưng file không tồn tại trong repo tại base. Nội dung đã được đối chiếu read-only
từ `supabase_migrations.schema_migrations` và khôi phục local tại:

`supabase/migrations/20260908014241_fix_public_booking_resource_catalog.sql`

Migration này đã tồn tại trên Production; file local chỉ khôi phục source truth,
không phải yêu cầu áp lại Production. Một regression test mới khóa projection,
filter và read-only ACL. Việc khôi phục parity không được dùng để che Advisor
ERROR; lỗi này chỉ được đóng sau rollout và kiểm chứng Production của #1417.

Hotfix đã merge và áp Production nằm tại
`supabase/migrations/20260921170000_harden_public_booking_resource_catalog_invoker.sql`:

- chuyển view sang `security_invoker=true` để loại definer-view ERROR;
- không thêm anon/auth policy hoặc grant vào bảng `salon_resources`;
- thêm helper `private.public_booking_resources_for_salon(uuid)` chỉ trả bốn
  field công khai và chỉ cho salon published/resource-enabled; schema `private`
  không nằm trong Data API exposed schema nên helper không trở thành Data API
  RPC. Chỉ stateless `anon` booking client và `service_role` được thực thi;
  `authenticated` bị thu hồi vì mọi production caller đều cố ý dùng client anon
  không mang session, còn contract authenticated lịch sử không thể chạy qua
  invoker views mà không mở rộng quyền bảng nội bộ;
- snapshot vẫn `SECURITY INVOKER` và gọi RPC hẹp này;
- cập nhật executable allowlist để khóa owner, search path, ACL, return shape và
  filter. RPC là ngoại lệ stateless-public có chủ ý; ngay cả khi người dùng đang
  có dashboard session, public booking vẫn tạo client anon riêng và không tái sử
  dụng cookie/session đó.

Hotfix này ở trạng thái **implemented, tested local/QA, merged và Production
verified**. Toàn bộ migration stack đã dựng lại thành công trên Supabase local và
QA; rehearsal transactional tạo tenant/resource synthetic, thử vai trò anon rồi
`ROLLBACK` đã PASS trên cả local và QA. Executable proof cho allowlist SECURITY
DEFINER/ACL cũng PASS. Production Advisor hiện trả 0 ERROR/20 WARN.

## Bằng chứng rollout Production

- PR #1417 merge lúc `2026-09-22T01:15:54Z`; merge SHA
  `7c5fad5bc9d52e24fcf852168b5d8184358b639e`.
- Standard migration dry-run dừng an toàn do Production lưu nhiều timestamp lịch
  sử khác local. Một migration workspace tối thiểu được dựng với stub cho đúng
  517 history record hiện hữu; dry-run sau đó liệt kê duy nhất
  `20260921170000`, rồi push thành công. Migration tự bao transaction và đặt
  `lock_timeout = 5s`.
- Migration list sau push khớp local/remote tại `20260921170000`. Migration
  parity `20260908014241` đã tồn tại trên Production và không bị áp lại.
- Schema dump xác nhận `public_booking_resource_catalog` có
  `security_invoker=true`; helper private có đúng return shape/filter; `private`
  schema và helper chỉ cho `anon`/`service_role`; snapshot không cấp EXECUTE cho
  `authenticated`.
- Security Advisor Production: **0 ERROR, 20 WARN**.
- Vercel project đang `sourceless`, vì vậy exact merge SHA được manual deploy từ
  clean detached worktree. Deployment `dpl_AKUpBoxBUQU4Hdcmd8TAVuMRRfJM` READY
  và alias tới `www.nailiq.ca`.
- Sau deploy: `/api/health`, `/hilite-anaheim` và `/hilite-studio` đều HTTP 200;
  không thấy runtime error trong cửa sổ log 10 phút.
- CI và E2E hậu-merge trên exact SHA SUCCESS, gồm non-RC và Receptionist Center
  desktop/mobile. Job có điều kiện bị SKIPPED không được tính là PASS.
- Không tạo booking, không gửi thông báo và không gọi provider.

## Kiểm thử local sau thay đổi

- Focused resource/definer/booking/performance Vitest: **4 files, 19/19 PASS**.
- Toàn bộ `src/shared/security/__tests__`: **230 files, 1.422/1.422 PASS**.
- TypeScript: `npm run typecheck` **PASS**.
- Supabase local: `npx supabase db reset --local --no-seed` **PASS**, gồm cả
  migration parity và hotfix mới.
- Rehearsal SQL rollback-only + executable ACL proof: **PASS**.
- `npx supabase db lint --local --level warning --fail-on error`: **0 error**;
  còn warning lịch sử ngoài phạm vi thay đổi này, không có warning cho helper
  resource mới.
- Focused quota/WAF Vitest sau khi bỏ placeholder: **4 files, 48/48 PASS**.
- Production build chuẩn: `npm run build` **PASS**, compile và TypeScript PASS,
  **61/61** static pages generated.
- Tenant E2E local disposable: **18/18 PASS** trên `chromium` và `mobile`
  (WebKit), mọi SMS/email/call/payment/provider credential tắt/rỗng.
- Supabase QA disposable migration push, rollback rehearsal, ACL proof và
  migration parity: **PASS**.
- Supabase QA Security Advisor: **0 ERROR, 20 WARN**; remote db lint:
  **0 error**, warning lịch sử được ghi nhận.

Lịch sử remote dùng timestamp khác local cho nhiều migration cùng tên. Do đó
không được so parity chỉ bằng version; phải ghép tên + nội dung/contract. Trong
lượt này, migration resource catalog là tên Production duy nhất thực sự thiếu
khỏi source sau khi bỏ qua hai tên safe-default bị remote lưu kèm prefix version.

## Bằng chứng Vercel Firewall

Production project `nailiq`:

- firewall enabled, active version 9;
- 1 custom rule active/valid: chặn stale noncanonical deployment writers và
  payment reconciliation sai host;
- không có draft change;
- không có system bypass;
- Attack Mode tắt;
- managed rules SQLi/XSS/RCE/... chưa active;
- rule `rule_p0_03_sdk_booking_page_load_observe_D3e16c`: condition
  `rate_limit_api_id=booking-page-load`, fixed window 60/60s/IP, vượt ngưỡng chỉ
  `log`;
- rule `rule_p0_03_sdk_contact_submit_observe_th7Swy`: condition
  `rate_limit_api_id=contact-submit`, fixed window 5/3.600s/IP, vượt ngưỡng chỉ
  `log`;
- trước publish, draft diff chứa đúng hai `rules.insert`; sau publish version 9
  không còn draft. Rule stale-writer hiện hữu không bị sửa;
- kiểm tra read-only ngày 22/09: cả hai rule vẫn active/valid, follow-up action
  vẫn là `log`, không có draft. Truy vấn `vercel.firewall_action.count` trong
  24 giờ gần nhất không trả nhóm mang ID của hai rule quan sát; dữ liệu tổng
  hợp này chưa đủ kết luận không có false positive hoặc đã đủ traffic để enforce;
- `booking-submit` và `auth-attempt` vẫn là hook dự phòng vì booking/auth hiện đi
  qua Supabase client SDK thay vì POST vào page route; không tạo rule chưa có
  runtime callsite;
- ba placeholder không có callsite (`magic-link-send`, `customer-lookup`,
  `card-save`) đã được xóa khỏi candidate. Customer lookup và card routes đã có
  durable fail-closed quota riêng; tạo WAF SDK rule không được code gọi sẽ không
  bảo vệ thêm request nào.

`src/shared/lib/rateLimit.ts` ghi rõ missing rule trả `not-found` và fail open.
Lớp durable limiter tại `src/proxy.ts` vẫn bảo vệ booking page, auth và public
API độc lập với WAF, nhưng không được dùng để tuyên bố WAF rate limiting đã bật.

## Việc còn lại để đóng toàn bộ P0-03

1. Quan sát log-only WAF để phát hiện false positive trước mọi đề xuất enforce;
   không đổi action chỉ vì database đã PASS.
2. Thu thập số liệu traffic/false positive và lập đề xuất enforce + rollback riêng
   nếu bằng chứng đủ. Không gọi log-only là protection enforcement.
3. Pilot/traffic thực vẫn NOT PROVEN; automated CI và synthetic QA không thay thế
   bằng chứng này.

## Lệnh xác minh chính

```sh
gh pr view 1416 --json state,mergeCommit,statusCheckRollup,url,mergedAt,headRefOid
gh pr view 1417 --json state,mergeCommit,statusCheckRollup,url,mergedAt,headRefOid
gh run view 35675117163 --json name,status,conclusion,url,headSha,jobs
npx supabase db advisors --linked --type security --level warn --fail-on none --output-format json
npx vercel firewall overview --json
npx vercel firewall rules list --json
npx vercel firewall diff --json
npx vercel firewall system-bypass list --json
./node_modules/.bin/vitest run src/shared/security/__tests__/authRateLimitBoundary.spec.ts src/shared/security/__tests__/edgeDurableRateLimit.spec.ts src/shared/lib/__tests__/rateLimit.spec.ts src/shared/lib/__tests__/inAppRateLimit.spec.ts
./node_modules/.bin/vitest run src/shared/security/__tests__/publicBookingResourceCatalogBoundary.spec.ts src/shared/security/__tests__/intentionalAnonSecurityDefinersBoundary.spec.ts
```

QA disposable phải chạy thêm rehearsal rollback-only sau khi áp hai migration:

```sh
psql "$QA_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f scripts/security/rehearse-public-booking-resource-catalog.sql
```

Rehearsal này dùng duy nhất tenant/resource synthetic trong transaction và luôn
`ROLLBACK`; nó khóa ACL, `security_invoker`, projection bốn field, filter salon
unpublished, snapshot stateless anon, cùng việc chặn authenticated khỏi
snapshot/helper trong khi direct table reads vẫn bị RLS chặn. Rehearsal đã PASS
trên Supabase local và QA disposable.
