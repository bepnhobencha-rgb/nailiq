# PR #1425 — Preview release receipt

## Đã publish theo phê duyệt

- PR: https://github.com/bepnhobencha-rgb/nailiq/pull/1425 — Draft, không auto-merge.
- Branch: `fix/waitlist-invite-identity-20260924`.
- Commit: `e1529dd214113dafcbeb48baa36ce1bac36eb7d5`.
- 5 file được commit: helper, 40 pipeline tests, 2 tài liệu nghiệm thu, và
  `vercel.json` khóa auto Git deployment đúng nhánh mới. Không file khác bị stage.
- Pre-commit scanner nhận nhầm UUID synthetic tên `token`; đổi tên thành
  `fixtureCapabilityId`, chạy lại 40 tests + lint PASS, rồi commit với hook
  nguyên trạng. Không dùng `--no-verify`.

## Cấu hình Preview an toàn

- Project `nailiq`, `prj_1yP37n3CAzbk5BaXizY5TWcOa7gV`.
- Supabase QA hiện có: `uhpzafoiifupyypkcwln`.
- 60 biến riêng branch, target chỉ `preview`; 32 khóa/kết nối ngoài để trống.
- SMS/email/call disabled; payment workers/charge/card-save dispatch/webhook
  ingestion OFF; demo OTP và slug-PIN bypass OFF. Không cấu hình provider thật.
- QA URL và JWT role/ref kiểm chứng trong bộ nhớ; service-role không in/log/lưu
  vào file. HEAD QA REST 200. Không sửa Supabase Auth/SMTP hay schema.
- Metadata hash ngoài branch không đổi trước/sau; Production deployment giữ
  `dpl_CXtHFN5AtkXQiTJtLhtiRePVYwFV` ở các cổng cấu hình.
- URL chuẩn của app/site đổi từ placeholder sang alias Preview đã xác minh,
  rồi build lại. Không đổi deployment protection, WAF hoặc production aliases.

## Deployment và smoke

- Bản khởi tạo (placeholder URL, không dùng nghiệm thu): `dpl_D3ZSVo7hZuDmdryNuXDQ6pv899Se`.
- Bản cuối: `dpl_2JVmqdUPpf7qaHXL1hpuzRsZ1jbi`, **READY**, target Preview.
- URL: https://nailiq-8q1x23m8z-bepnhobencha-2588s-projects.vercel.app
- Alias: https://nailiq-git-fix-waitlist-invi-46a9a9-bepnhobencha-2588s-projects.vercel.app
- `vercel inspect <url> --wait --timeout 45s`: READY, Preview.
- `vercel curl /api/version --deployment <url>`: đúng commit `e1529dd2…`.
- `vercel curl /api/health --deployment <url>`: status `ok`, version đúng,
  timestamp `2026-09-24T20:40:26.319Z`.
- Computer use: mở `/login`, nội dung EN hiển thị, đổi VI hoạt động, screenshot
  không thấy chồng chữ/nút ở viewport đang dùng. Không nhập credential hoặc
  submit login/booking/invitation. Đây chỉ là hosted UI smoke, không phải
  hosted role/Waitlist end-to-end acceptance.
- Quan sát ngoài phạm vi: tab title vẫn “Đăng nhập” khi nội dung EN; không sửa
  lỗi copy ngoài phạm vi guard này hoặc gọi toàn bộ song ngữ là 100%.

## CI

- CI run `36055985877`: SUCCESS (unit/type/lint/build/security + browser fixtures).
- CI unit: 6.717 PASS / 65 skipped, 853 files PASS / 6 skipped.
- Waitlist delivery browser: 28/28 PASS (57,7 giây), Chromium + WebKit, EN/VI;
  gồm network/503 recovery, không báo thành công giả hoặc nhân đôi lời mời
  trong fixture. Không gọi đây là provider/DB integration proof.
- E2E run `36055986023`: **SUCCESS**; PR cuối **22 SUCCESS, 2 SKIPPED,
  không pending/FAIL**. Skipped: AI Triage và MQA-0148 thủ công, không tính PASS.
- Settings recovery real-auth: **196/196 PASS** (17,9 phút).
- Các job đã hoàn tất: Receptionist Chromium 109 PASS / 4 skipped (6,6 phút);
  SuperAdmin real-auth HTTPS 54 PASS (5,4 phút); tenant roles/session revocation,
  Visual Regression và Smoke SUCCESS.
- Receptionist mobile: 103 PASS / 10 skipped (10,2 phút).
- Non-RC: 179 PASS / 2 skipped (8,5 phút); các bước bổ sung lần lượt
  Guided Setup 6, Reports hydration 1, Superadmin authority 6, booking capability
  7, registration authentication 3, booking submission WebKit 10, group guest
  placeholders 18 — tổng 51 PASS. Không tính thành hosted/live booking proof.

## Ranh giới

Không merge/deploy Production, không migration, không gửi tin/provider, không
tạo hoặc sửa dữ liệu salon thật. Không tạo fixture/account hosted mới trong
lượt smoke. Các fixtures CI thuộc môi trường disposable của workflow.
PR vẫn Draft. P1-01 provider terminal delivery và nghiệm thu iPhone/người mới
chưa được đóng bởi receipt này.

**Kết luận: publish PR/Preview và CI acceptance PASS trong phạm vi trên.
Không chứng nhận toàn bộ Master Plan hoặc Production của patch mới.**

Tài liệu này là receipt local sau publish, chưa commit/push trong batch đầu;
trạng thái từ PR và CI là nguồn đối chiếu hiện hành.

## Follow-up: hosted Waitlist prerequisite audit

- PR rechecked: OPEN, Draft, CLEAN, same `e1529dd214113dafcbeb48baa36ce1bac36eb7d5`.
- Read-only `vercel firewall rules list --json`: three live rules, no draft,
  no pending changes. The active stale-deployment-writers fence denies methods
  other than GET/HEAD/OPTIONS for hosts outside its explicit allowlist.
- Neither the new PR #1425 immutable deployment host nor its branch alias is
  in that allowlist. This is a configuration-derived blocker, not a reproduced
  authenticated Waitlist action failure. The separate payment-reconciliation
  path fence must remain unchanged.
- Anonymous GET and empty POST to `/api/version` on the branch alias both
  returned HTTP 302. The checked source exports only GET and has no mutation.
  These probes do **not** prove a WAF 403 or successful app access; they hit a
  redirect and were not followed. No credentials or customer data were sent.
- No WAF draft/publication, synthetic account, tenant, booking, invitation,
  provider call, or Production change was made in this follow-up.

### Exact next hosted acceptance scope (prepared, NOT RUN)

1. Recheck branch SHA, QA project binding, disabled outbound paths, and empty
   provider credentials before creating a new uniquely named synthetic tenant.
2. Use separate owner/receptionist accounts plus an isolated second tenant;
   do not reuse, alter, or delete the existing day-6 human-handoff fixture.
3. Open Receptionist Center through the normal UI. Confirm waiting entries,
   disabled terminal/group states, and EN/VI explanations without exposing
   full contact details in the main list.
4. Confirm one selected entry through the normal server action. Assert durable
   salon/entry identity, expected offer epoch, and honest suppressed/unavailable
   delivery status. Never label provider-disabled QA as delivered.
5. Retry/reload and use two authorized sessions to check no duplicate offer
   for the same epoch. Distinguish real database evidence from existing mocked
   concurrency tests. Check opt-out and missing-contact cases with synthetic
   data only.
6. Verify the second tenant cannot access or mutate the first tenant's entry
   through the normal authorization path; record the observed response.
7. Revoke the created synthetic sessions and remove only records identified
   by this run's IDs. Verify no fixture records remain and no unrelated data
   was modified.

Before steps 2–7, obtain approval for a narrowly scoped WAF draft adding only
`nailiq-git-fix-waitlist-invi-46a9a9-bepnhobencha-2588s-projects.vercel.app`
to the **first** host allowlist clause. Preserve the second payment cron clause,
all existing hosts, actions, and other rules. Review the full diff and have the
user publish it. Do not use an older allowed hostname, alternate transport, or
blanket bypass to evade the current fence. Re-read the live rule after publish.

**Follow-up verdict: prerequisite audit complete; hosted role/Waitlist E2E
BLOCKED / NOT RUN. Local and CI results above remain valid but do not close
this evidence gap.**

## Follow-up: narrowly scoped WAF draft prepared

At `2026-09-25T00:19:23.670Z` (September 24 in Vancouver), after the user's
request to complete this prerequisite, prepared **one unpublished WAF draft**:

- Revalidated READY Preview `dpl_2JVmqdUPpf7qaHXL1hpuzRsZ1jbi`, project,
  branch, exact commit, and ownership of the branch alias before staging.
- Before staging: no pre-existing draft or pending changes.
- Added only the PR #1425 branch alias to the first existing host allowlist.
- Structural before/after checks PASS: the complete payment-reconciliation
  clause, action `deny`, enabled state, description, name, and other rules
  are unchanged. Exactly one pending change.
- Computer use opened the real Vercel **Review Change** dialog. It explicitly
  says staged/not yet live and displays the final **Publish** button.
- **Did not click Publish.** The Vercel Firewall skill requires user handoff
  for publication. No alternative API/publication path was used.
- The draft changes project firewall configuration, not the application
  deployment. Its intended traffic change is limited to the verified QA alias;
  canonical Production hosts are untouched. Hosted E2E remains NOT RUN until
  the user publishes and the live rule is verified again.

Handoff URL: https://vercel.com/bepnhobencha-2588s-projects/nailiq/firewall/rules

No code edits, commit, push, migration, fixture creation, provider call, or
application deployment occurred during this draft preparation.

## Unblocked work: real PostgreSQL local rehearsal

User was away and asked for another way to progress. Ran existing checked-in
Waitlist SQL rehearsals against the existing **local disposable** Supabase
stack, not through a bypass of Vercel and not against hosted QA/Production.

- Runner: `/private/tmp/nailiq-pr1425-local-waitlist-qa.mjs`.
- Command: `node /private/tmp/nailiq-pr1425-local-waitlist-qa.mjs`.
- Pinned CLI 2.117.0 offline invocation was unavailable in the current npm
  cache. Used the existing Supabase CLI **2.76.8 only to read local status**;
  no install, upgrade, migration, container restart or schema change.
- Guarded target: API `127.0.0.1:54321`, Postgres `127.0.0.1:54322/postgres`,
  existing local stack. Refused dotenv, existing salon fixtures, fixture
  categories, or any active database cron job. Credentials stayed in memory.
- `rehearse-waitlist-claim-capabilities.sql`: PASS; transaction rolled back.
  Covered exact capability/retry/epoch behavior, cross-salon truth projection,
  browser-role EXECUTE restrictions, synthetic terminal delivery events and
  prevention of late accepted events overwriting terminal failure.
- `rehearse-waitlist-claim-capabilities-concurrency.mjs`: PASS with real
  concurrent PostgreSQL sessions: 20 capability mints, 2 delivery claims,
  10 customer claims, 10 booking-scoped promotions, 10 selected-entry
  promotions. Assertions verify one winner/receipt and stable capability.
- Cleanup re-read: **0 salons, 0 fixture categories, 0 fixture entries,
  0 fixture delivery outbox rows**. No unrelated fixtures existed or were
  removed. The separate hosted iPhone handoff fixture was never accessed.

**PASS LOCAL DATABASE** adds independent database/race evidence. It does not
exercise the new TypeScript identity guard through hosted authentication/UI,
prove provider delivery, or close the unpublished WAF/hosted E2E gate. No
WAF publication, commit/push, app deployment, or external notifications.

## Hosted Preview follow-up — 2026-09-25 00:35–00:41 UTC

Supersedes the earlier hosted BLOCKED status for the cases below.

- User published the narrow WAF change. Fresh read: live, no draft, zero
  pending changes, deny rule active; only the verified QA alias added.
  Payment-reconciliation path remains fenced, including on the QA alias.
- Reverified READY deployment `dpl_2JVmqdUPpf7qaHXL1hpuzRsZ1jbi` at
  `e1529dd214113dafcbeb48baa36ce1bac36eb7d5`, QA project
  `uhpzafoiifupyypkcwln`, branch-scoped environment and outbound kill switches.
- Used actual computer-use login as a synthetic receptionist, normal dashboard
  UI and server actions. Created two disposable salons and two disposable
  accounts; no real salon or customer records used.
- Invite now: only the selected individual entry became notified. Exactly two
  epoch-1 delivery rows, both suppressed/channel_disabled, no provider receipt.
- Invite again: same offer epoch, timestamp and two rows; no duplicate delivery.
  Reload retained the honest Invitation open / Turned off / needs-attention UI.
- Missing email: UI Email Contact missing; durable email result
  suppressed/recipient_missing and SMS suppressed/channel_disabled.
- Group review remained review_required with no invite action; no booking
  created. Booking count stayed zero throughout the tests.
- Main list masked phone and omitted email. Details showed the selected
  synthetic contact. Escape closed details and returned focus to its name.
- Cross-salon URL as receptionist redirected to its own salon dashboard;
  no other salon operational data displayed. This is UI route evidence,
  not a substitute for comprehensive API/SQL tenant tests.
- Cleanup PASS: both fixture salons gone, two auth accounts removed, sessions
  revoked. Protected-page reload redirected to login. No unrelated fixtures
  touched. Test-only deletion is permanent; no real data removed.

Fixture command: `node /private/tmp/nailiq-pr1425-hosted-fixture.mjs` with
private in-memory credentials; `inspect` for scoped durable evidence and
`finish` for guarded cleanup. First attempt was rejected by the existing
invalid_waitlist_source guard and fully cleaned. Corrected only the fixture
to supported slot_unavailable at a closing-time slot; no safeguard bypass.

**PASS for the hosted receptionist invite/retry/missing-contact/group-gate/
reload/detail/Escape/cross-tenant-route cases above.** No real provider delivery,
hosted concurrent race, owner UI, mobile physical-device or human acceptance
was tested in this follow-up; those are not claimed PASS. The drawer's joined
timestamp appeared in browser-local time while the fixture calendar used UTC;
timezone-label clarity and English-page/Vietnamese-document-title consistency
remain UX observations for separate triage, not silently marked resolved.

No application code changes, migration, commit, push, merge or application
deployment in this follow-up. No SMS/email/call/payment provider invocation.
PR #1425 remains a Preview review candidate, not Production acceptance or
100-percent Master Plan completion.

## Owner VI / responsive follow-up — 2026-09-25 00:42 UTC onward

- Fresh GitHub read: same exact head, OPEN/Draft, MERGEABLE,
  22 SUCCESS / 2 SKIPPED. No additional application edits.
- Re-ran the guarded fixture setup on the same QA-only Preview. This is a
  separate disposable run; prior fixtures were not reused or resurrected.
- Actual Owner login via UI, Vietnamese selected on login and retained in
  dashboard. Role visibly Chủ tiệm.
- At 375×667 viewport, Mời ngay succeeded through the authenticated action;
  only selected individual entry became notified. Two epoch-1 outbox rows,
  SMS/email suppressed/channel_disabled and no provider receipts.
- Mời lại retained identical notified timestamp, epoch and two rows. Group
  remained review_required; the other individual remained waiting. Bookings 0.
- UI accurately showed Đang mời, Cần kiểm tra thông báo, SMS/Email Đang tắt.
  It did not claim delivery. Drawer showed the correct synthetic customer,
  scrolled to call/copy actions without horizontal clipping in the observed
  screenshots. Close button returned keyboard focus to customer name.
  Call/copy actions were not executed; no external call or clipboard claim.
- Viewport override reset. Cleanup PASS: both newly created salons gone,
  two accounts removed and sessions revoked. Protected reload returned to
  login. No real salon/customer data, prior handoff fixture or provider touched.
- Timestamp observation confirmed in source: OnlineWaitlistPanel.tsx formats
  createdAt with Intl.DateTimeFormat without timeZone. Browser displayed
  Vancouver time while fixture salon calendar used UTC. Track separately as
  a timezone presentation issue, not a mutation or delivery failure.

**PASS: additional hosted Owner VI / responsive invite and retry cases.**
Still NOT PROVEN: physical iPhone, first-time-human timing, real terminal
provider delivery, and hosted concurrent race. Existing local real-Postgres
race evidence remains a distinct layer. PR remains Draft, not Production.

Next release boundary: review/publish these local evidence updates and move
PR #1425 to Ready only with authorization; merge/Production remains separate.
No extra provider test is implied by release approval. Provider acceptance
requires an exact QA recipient, permitted channel/count and callback receipt
scope; historic one-email approvals are not reused for a new message.
