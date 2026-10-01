# P1-01 hosted callback WAF verification — 2026-10-01

## Scope and verdict

Baseline PR #1441 is Draft at `7f9fd58221388556ecca7caebb8e0accfa8b6bdc`.
The owner subsequently approved publishing exactly the workflow, its source
invariant test, and this evidence document into the same Draft PR. No merge
or Production release is authorized. Published-head CI below predates that
three-file follow-up; the new head must receive its own CI evidence.
Day 22 / P1-01 remains OPEN. Master Plan completion is NOT PROVEN.

Owner approved a temporary exception only for POST `/api/twilio/inbound` and
`/api/twilio/status` on the previously named QA Preview hostname. No provider,
real notification, real booking, Production environment or database mutation
was permitted.

## WAF boundary — PASS and revoked

- Confirmed no pre-existing draft before modification.
- Modified only `rule_card_receipt_release_fence_stale_deployment_writers_20260911_poPsrq`.
- Preserved deny action and all original protections except the exact two
  callback POST requests on the approved QA hostname in Preview.
- A 2,688-case condition truth table found exactly two changed cases; all
  other host/path/method/environment decisions were unchanged.
- Published the project-level WAF revision under the owner's explicit approval.
  This is a configuration revision, not an application Production deployment;
  Production matching semantics were unchanged.
- An initial truth-table harness expected the QA hostname to be exempt even
  when classified as Production. That assertion failed before any mutation.
  The expectation was corrected to Preview only; no failed evidence was erased.
- After HTTP checks, restored and published the exact original conditions and
  action. Read-back confirms the temporary exception is revoked.

## Hosted HTTP negative checks — 6/6 PASS

Deployment: `dpl_7HjYVWEuiPJ5TwG8Kq2CaAJ6QRXp`.

| Check | Actual result |
| --- | --- |
| Inbound JSON body instead of form | application 400 Invalid request |
| Status JSON body instead of form | application 400 Invalid request |
| Inbound form without signature | application 403 Forbidden, not WAF deny |
| Status form without signature | application 403 Forbidden, not WAF deny |
| Different POST writer `/api/booking/submit` | WAF 403 deny |
| PUT to inbound callback | WAF 403 deny |

No authorized command or terminal delivery receipt was submitted. These checks
prove the ingress boundary and retained protection; they do not prove durable
callback writes or provider delivery. Both atomic adapters were OFF on this
deployment.

## Next isolated Preview prepared, positive tests NOT PROVEN

Deployment `dpl_3bTvXyvN8MBjBgUC1FngLz1DB7Vg` is READY at:
`https://nailiq-2n8g4x6k8-bepnhobencha-2588s-projects.vercel.app`.

Verified exact commit, branch, Preview target and absence of Production aliases.
Only the approved QA branch has the two atomic adapters temporarily enabled.
A synthetic HMAC token override was added on this branch; it is not a Twilio
provider credential. Both Supabase URLs point at disposable QA
`uhpzafoiifupyypkcwln`; all 19 provider kill switches remain OFF/disabled.
Production target and environment fingerprint were unchanged.

At the earlier checkpoint, enabling deployment environment variables required redeployment and generated
a different immutable hostname. The old hostname exception does not authorize
this new hostname. An explicit narrow authorization request for the new
hostname is pending; no write probe or bypass has been attempted there.
Its WAF write fence remains intact. No synthetic fixtures were persisted in QA
in this batch; the QA platform settings row was checked to be absent.

After the remaining authorized synthetic tests, remove the three owned QA
branch environment entries, redeploy with adapters OFF, and revoke the new
exception if approved. Do not delete or alter unrelated environment entries.

## GitHub terminal evidence — attempt 1

CI run `36878780263`, E2E run `36878780222`, and migration rehearsal run
`36878780283` completed SUCCESS at published head `7f9fd582...`, attempt 1.
No automatic rerun was performed. E2E has 10 successful jobs and 2 skipped jobs
(MQA-0148 and AI Triage); skipped is not tested.

- Build and type check job: PASS, default build 61/61.
- Actual CI unit result: 889 files passed, 10 skipped; 7,437 tests passed,
  227 skipped. This differs from local combined-worktree counts and is the
  published PR-head CI evidence.
- Security audit job: PASS; npm and pnpm report zero known vulnerabilities.
- CI checks the PR merge-ref `fe8d12fb00ce79f616b1fc615c14a9950632179c` for
  PR head `7f9fd582...`; Preview checks the literal head. Keep these separate.
- Password-reset browser job completed; its long browser-install step was
  distinguished from an application timeout.
- SuperAdmin recovery / real-auth HTTPS completed: 54 tests passed.
- Non-RC batch: 179 passed, 2 skipped; follow-up focused batches passed.
- WebKit booking-submit diagnostic: 10/10 passed, retries 0. This does not
  prove the earlier native-crash root cause was repaired.
- Server-log dump retains 15 `The destination stream closed early` errors,
  digest `4056115534`. The dump appeared after the final 18-test batch passed,
  but printed timestamps are log-dump timestamps, not proof of error occurrence
  at shutdown. Cause/production applicability remains NOT PROVEN.
- Real-auth HTTPS log retains cookie-write warnings from Server Component
  context. Passing assertions do not make either server log error-free.

## Additional local CI coverage — not published

Found that migration rehearsal checked ledger metadata/ACL but did not execute
the existing 20-scenario atomic-confirmation fixture. Local changes add its
path trigger and run the fixture with `psql -X -v ON_ERROR_STOP=1 -q`, separate
`-c BEGIN`, `-f supabase/tests/inbound_sms_confirm_atomic.sql`, `-c ROLLBACK`.
Source invariants enforce both trigger and rollback-wrapped execution.
The already-completed GitHub run does NOT prove this unpublished wiring ran.

- RED before workflow fix: 4 passed, 2 failed in release-boundary spec.
- After fix: 68/68 focused tests in 3 files PASS; YAML parses; typecheck and
  touched-file ESLint PASS. `git diff --check` PASS.
- Fresh actual local PostgreSQL container, network none / no host ports:
  550 migrations and 20 SQL scenarios PASS. Successful fixture rollback and
  deliberate post-fixture SQL error both leave all public/auth/turniq_private
  table counts/digests unchanged. Owned container removed.
- Local transport uses `psql -f -` with identical fixture bytes because Colima
  file transport failed; it is equivalent CLI transaction execution, not an
  exact hosted CI filesystem or actual Supabase Auth-runtime rehearsal.
- Retain failed harness receipts b127 (fixture not found), b128 (container
  creation assertion; precise cause not captured), b129 (incorrect expectation
  of exit code 3 for a `-c` SQL error). A minimal PostgreSQL diagnostic b130
  proved command error exit 1 vs script error exit 3; both rolled back. Corrected
  b131 rehearsal PASS with injected failure exit 1. No application/RPC behavior
  was changed to get a green harness.
- Default local sandbox build remained idle for over 12 minutes; stack sample
  retained, own process terminated gracefully with exit 143. Not a PASS.
  A separately authorized local default-build check PASS: Next 16.3.8 Turbopack,
  61/61 pages, exit 0; source/config unchanged, external transport guard retained,
  explicit provider kill switches set. This is an environment-specific contrast,
  not a proven root-cause fix for the sandbox stall. No bundler/configuration
  change or application deployment occurred.

Only workflow, its release-boundary spec, and this evidence document changed
in this local follow-up. Sixteen unrelated files have identical baseline hashes;
the two unrelated staged documents remain staged. No new commit/push was made.

## Retained concurrency state rechecked — read only

The owned synthetic local database from `confirm-concurrency-b103.json` remains
identifiable by its ownership comment and has zero Auth users. Read-only
inspection confirms the function-definition MD5 is
`6567624dc424050ca76550f2fe11191d`, matching the measured confirmation function.
The ten-way-race booking is completed with exactly one confirmation event and
one notification; its next appointment remains pending. The lock-drift booking
is cancelled, its next appointment remains pending with zero events/notifications.
There are two immutable inbound receipts. This is a present-state corroboration
of the prior local race receipt, not a rerun or hosted/provider proof.

No duplicate CI monitor remains: the terminal-results heartbeat was deleted
after reporting all three published-head workflows SUCCESS and skipped jobs.
Next boundaries remain exact-new-host WAF approval and publication approval
for the three local follow-up files. Those approvals were subsequently given
explicitly and executed in the new-host batch below; they were not replaced by an automatic
goal continuation or by the old-host WAF permission.

## Retained private artifacts

Parent workspace holds the original/proposed/staged WAF snapshots (`b123`),
six-case HTTP receipt (`b124`), owned environment IDs and new Preview receipt
(`b125`), and verified WAF restoration receipt (`b126`). These contain no
real customer information or provider credentials.

No merge, Production deployment, Production database mutation, provider call,
SMS/email send, or real booking creation occurred. The new-host batch creates
and then removes five synthetic QA bookings only. Sixteen unrelated worktree
files and the two unrelated staged documents were preserved.

## Approved new-host synthetic batch — Preview/QA verified

The owner explicitly approved the exact new immutable hostname and the
three-file publication boundary. QA project identity, literal deployment SHA,
Preview target, 19 provider kill switches, Production environment fingerprint,
and Production target were checked before the temporary exception.

Sensitive Vercel variables cannot be retrieved by the API. An initial guard
incorrectly expected value readback and stopped before any WAF mutation.
The corrected guard checks exact owned IDs, sensitive type and branch-only
scope, retaining the creation receipt. Signed hosted requests prove that the
synthetic HMAC token and atomic confirmation/cancellation adapters are used;
no attempt was made to decrypt or downgrade a sensitive variable.

Both WAF lifecycles passed the 2,688-case truth table (exactly two changed
Preview cases), retained all other writers and Production matching, and ended
with read-back of the original rule. A publish command attempted before the
second staging finished failed on a missing snapshot before any mutation;
publication proceeded only after the staging receipt existed and exact diff
comparison passed. These harness failures are retained, not application fixes.

### Hosted HTTP assertions and durable data

- 11/11 ingress assertions PASS on the new Preview: invalid content types,
  missing signatures, signed HELP and raw encoded query, tampered query, invalid
  SID, recognized nonterminal status, and retained unrelated writer/method deny.
- 21 qualified positive/safety case groups PASS, representing 30 HTTP requests.
  Together with ingress, 41 qualified HTTP assertions passed. These are direct
  hosted HTTP checks, not visual UI or real Twilio requests.
- Ten concurrent first-confirm requests use one synthetic MessageSid and leave
  exactly one immutable inbound receipt, one confirmation event and one inbound
  notification. Exact retry succeeds; changed body and switching to NO under
  the same SID fail closed (503).
- After the owned synthetic booking was completed, a retry of its original
  confirmation returns the retained result. The next booking remains pending
  with no confirmation event or notification. Neither ambiguous two-salon
  intent nor missing booking changes a booking.
- Signed NO cancellation and exact retry leave one cancellation event and one
  inbound notification. The extra terminal-policy authorization audit event is
  a different event type, not a duplicate cancellation.
- STOP/START retries are write-free and return empty TwiML. The consent ledger
  has three synthetic events: one from the retained CANCEL test below, followed
  by the intended STOP and START. Final provider-sender state is clear. Changed
  consent under an existing SID fails closed.
- A manually seeded synthetic accepted attempt receives a signed delivered
  callback. Universal attempt and domain notification become delivered, with
  exactly one attached terminal receipt. Exact retry succeeds; conflicting
  failed receipt and wrong SID return 409; query tampering returns 403;
  later recognized nonterminal status does not overwrite delivered.
- Database assertions independently verify four inbound receipts, one confirm
  event, one cancel event, one terminal status receipt, three consent events,
  and unchanged next/ambiguous booking states. No provider was contacted.

### Retained failed expectation — not hidden by green continuation

The first positive driver expected body `CANCEL` to invoke booking cancellation
and reject reuse of a confirmation SID. It returned 200 instead of expected
503, so testing stopped and the WAF exception was immediately restored.
Inspection showed the existing deployed classifier intentionally treats
`CANCEL` as the carrier STOP keyword. It recorded consent suppression and did
not cancel the confirmed booking. Booking cancellation uses `NO/HỦY`.

The continuation changed only the test vocabulary to NO and ran the previously
unexecuted cases; no app, classifier, RPC or schema code changed. The first
driver's FAIL receipt is retained. The route's introductory CANCEL comment is
outdated; the implemented classifier contract is authoritative for this test.

### Cleanup and remaining gates

The exact original WAF rule was restored and published after all callbacks.
Both owned synthetic salons, their five bookings/catalogs, and the synthetic
platform settings row were removed. Existing QA remains two salons, three
bookings and four Auth users; existing salon/booking/Auth row hashes match the
baseline. No immutable guard, ACL or RLS policy was disabled for cleanup.

Four opaque append-only inbound receipts and three hashed synthetic consent
events intentionally remain as QA audit evidence. Therefore this is not a claim
that every synthetic ledger row was erased. Terminal status receipt also
survives domain cleanup without a live notification reference.

Exactly the three owned branch environment entries were removed; every
unrelated environment entry and the Production fingerprint/target match their
baseline. Cleanup Preview `dpl_FsdAXYDYTLAUhWcyHPwMo91UDinN` was requested at
literal head `7f9fd582...`, initially INITIALIZING, with default-OFF atomic
adapters. READY must be checked independently. Cleanup readback and the
deployment result are recorded separately; an immutable earlier deployment
retains its original environment and is WAF write-fenced. It is not made OFF
by removing branch environment entries.

Provider-origin SMS delivery, real Twilio retry/STOP enforcement, actual hosted
reminder scheduler, physical-device use and human pilot remain NOT PROVEN.
This batch advances hosted synthetic callback evidence, not Day 22 closure or
100% Master Plan acceptance. No permission for Production is implied.

Artifacts: `waf-callback-*-b134.json`, `waf-callback-*-b139.json`,
`callback-hosted-negative-b135.json`, `callback-hosted-positive-b137-*.json`,
`callback-hosted-durable-b140.json`, and the scoped cleanup SQL `b141`.

## Publication and native CI failure — retained, not a green retry

The approved three-file follow-up was committed and pushed once as
`f936afb59e648a150cb401e02b5abc73fd510b92`. Git remote and PR read-back agree;
PR #1441 remains Draft. The publication driver initially saw the old PR head
after the successful push (eventual consistency). A separate read-only check
verified publication; no duplicate push or force push was performed.
All sixteen unrelated dirty-file hashes and the two unrelated staged files
were preserved.

Preview `dpl_3cXyXzujyivgMDCnVh7WfPug6Nnv` is READY at the literal new head.
Cleanup Preview `dpl_FsdAXYDYTLAUhWcyHPwMo91UDinN` is also READY at its earlier
head. Neither has Production aliases. Branch overrides are removed, default
atomic adapters are OFF, and the original WAF rule is restored with no draft.

Migration run `36893592394`, attempt 1, FAILED at the newly wired SQL fixture:
`server closed the connection unexpectedly`, psql exit 2. Schema history,
parity and ledger metadata/ACL passed first. CI did not capture the native
server log before cleanup, so this CI output alone does not prove a signal.
Other CI/E2E jobs on this head must be assessed separately, not borrowed from
the previous head or inferred from Preview READY.

### Root-cause contrast on owned local containers

- The tracked `supabase/.temp/postgres-version` is `17.6.1.111` despite the
  ignore rule. Supabase CLI 2.109.1 reads this cache and overrides its default
  PostgreSQL image. An actual CLI `services` check confirms that selection.
- With Supabase's hint/reserved-role settings, image `17.6.1.111` applied all
  550 migrations, then crashed at cases 16–17 (real anon/authenticated EXECUTE
  denial). The owned server log records `signal 11: Segmentation fault`.
- Identical history/fixture and diagnostic settings passed all 20 cases on
  `17.6.1.143` and `17.6.1.167`. These are local image comparisons, with bare
  auth stubs, not a hosted Auth or provider test. Every owned container was
  removed; the shared local database was not used for these crash probes.
- A further .143 container initialized with `supabase_admin` as bootstrap
  superuser and `postgres` as NOSUPERUSER/CREATEROLE/CREATEDB/BYPASSRLS also
  passed all 20 cases after all 550 migrations. Retain b149's earlier harness
  failure: initdb's bootstrap postgres cannot be demoted. That failed before
  the fixture; b151 corrects initialization, not application privileges.
- [Supabase's upstream issue and maintainer resolution](https://github.com/supabase/postgres/issues/2112)
  confirm supautils 3.2.0/3.2.1 denied-function crashes in image tags .099–.112,
  fixed from supautils 3.2.2. Do not infer hosted Production uses that old
  extension merely because a tracked local cache does.

### Scoped correction and verification

Only the same three approved files change. The workflow quarantines the
runner checkout's legacy linked cache before `supabase start`; it does not
delete tracked developer files, change a cloud project, upgrade the CLI, grant
EXECUTE, suppress role tests or alter application SQL. A sanitized failure
diagnostic records image/OOM/native signal without statements or payloads.

The exact workflow shell step was tested in a separate temporary directory:
CLI 2.109.1 resolves .111 before quarantine and .143 afterward. Running the
step again without a cache also succeeds. CLI telemetry was disabled. The
first private harness incorrectly parsed human-table output as JSON; it
failed before moving the cache, and was corrected to request JSON explicitly.

Local corrected gates: 70/70 focused tests across three files, typecheck,
touched-file ESLint, YAML parse and diff check PASS. The first YAML harness
referenced an unavailable `yaml` package; using the already-installed
`js-yaml` parser passed. Neither harness failure was an application change.
No unchanged CI rerun was requested. Corrected-head CI/complete blank Supabase
runtime remains NOT PROVEN until its own run finishes.

Private evidence: `confirmation-native-b144.json`, `-b145.json`, `-b146.json`,
`-b147.json` (including the retained native crash log), `clean-cache-b148.json`,
`confirmation-native-b149.json`, `-b151.json`, and
`callback-publication-verified-b143.json`. No Production, provider or real
notification action was performed.
