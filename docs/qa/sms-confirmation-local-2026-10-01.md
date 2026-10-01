# P1-01 — Signed YES confirmation: local fix and hosted boundary

Date: 2026-10-01. Day 22 remains open. This report is not a release approval.

## Status

| Evidence layer | Result |
| --- | --- |
| Published PR #1441 base `ab98bc2c` | Previous exact-head CI, E2E and migration-history jobs PASS; PR remains Draft |
| Branch-only Preview cron configuration | PASS; sensitive random CRON_SECRET supplied in memory, 19 provider switches OFF |
| New Preview `dpl_Bbhe72SiDCFdk1stAhwjytLA5U63` | READY at `ab98bc2c`; `/api/ready` 200 with schema and cron authorization ready |
| Malformed hosted callback rejection | BLOCKED; expected app 400, received edge 403 with `x-vercel-mitigated=deny` |
| New YES confirmation fix | Local gates PASS; additive RPC applied and tested on disposable QA; publication in this approved batch pending |
| Fresh blank PostgreSQL history | Follow-up `b108` PASS: all 550 migrations, exact repository parity, ACL and 20 SQL scenarios |
| Full callback URL signature | Real HTTP reproduction `b109` FAIL retained; corrected fresh clone `b110` PASS, all 14 HTTP scenarios |
| Atomic-OFF / consent compatibility | Fresh clone `b115` PASS, 14 actual HTTP/database scenarios; harness failure `b114` retained |
| Local security/performance advisors | `b119` PASS for migration delta: zero new WARN/ERROR, zero added/removed findings; not hosted advisors |
| Hosted QA confirmation SQL and ACL | 20/20 rollback scenarios PASS; service-only execution and empty search path verified |
| Hosted QA advisors | Before/after identical: 482 INFO, 104 WARN, 0 ERROR; zero added/removed findings, existing warnings not resolved by this batch |
| Production, actual provider delivery, scheduler and human pilot | NOT PROVEN for this change; not exercised |

The approved Preview is
`https://nailiq-dvsjxofcz-bepnhobencha-2588s-projects.vercel.app`.
It does **not** contain the new local confirmation fix. Do not substitute its
readiness result for the confirmation acceptance tests.

## Reproduced failure and fix

The legacy YES path selects an upcoming appointment before resolving a durable
provider command receipt. A retry after completion can therefore select a
different appointment. The legacy limited candidate query can also hide a
second salon from ambiguity detection. Two red reproduction tests were retained
outside this new batch; their failure was not erased or relabelled as PASS.

Actual signed HTTP run `b109` found a separate URL-integrity defect: the inbound
handler omitted the URL query string from signature validation. A request whose
signature covered the path but not its tampered query returned 200 instead of
403. The run stopped after three passing cases and retained its failure log and
owned clone. The local handler now includes `req.nextUrl.search`, without
reordering or decoding the query string. This follows the [Twilio full-URL
signature contract](https://www.twilio.com/docs/usage/security#validating-requests).
This signature correction applies before the default-OFF atomic branches,
including consent and legacy commands; it must be reviewed as a common inbound
boundary, not described as entirely feature-flagged.

The additive migration
`20261001114926_add_atomic_inbound_sms_confirmation_receipts.sql` creates only
`confirm_booking_from_signed_sms(text,text,text,text,text)`. It uses the existing
private inbound command ledger rather than another receipt table.

- Authenticate the signed request in the HTTP adapter before the RPC.
- Lock and resolve MessageSid receipt before mutable appointment selection.
- Reject changed body, sender, destination or action under the same command ID.
- Verify configured account and destination, then reject multi-salon ambiguity.
- Preserve the existing reminder-preference selection policy and deterministic ties.
- Use the existing booking advisory lock followed by a row lock; revalidate
  selected material after waiting. A changed appointment is pinned in its
  receipt, never silently replaced by the next appointment.
- Commit confirmation, preserved `confirmed_at`, event, inbound notification
  record and immutable receipt together. A late insert error rolls back all.
- Keep browser execution revoked and an empty definer search path. Service RPC
  execution is also checked against the JWT service role.
- New HTTP branch is gated by `NAILIQ_ATOMIC_INBOUND_SMS_CONFIRM === "true"`,
  absent/OFF by default. Errors never fall back to mutable legacy selection.

The default-OFF boundary means the legacy behavior is **not fixed in
Production by this local work**. No booking, payment, outbound dispatch,
waitlist promotion or live-salon policy is added by the confirmation RPC.

## Exact local verification

Private harnesses are in `/private/tmp/nailiq-current-main-combined-iBPOnd`.
They strip inherited hosted credentials and retain a loopback-only network
fence. PostgreSQL commands target the owned local Docker stack, never a hosted
project. These are actual commands, not instructions to run on Production.

| Command | Result |
| --- | --- |
| `node confirm-route-tests-b94.mjs` | 70/70 tests across four files PASS; includes 26 new mocked adapter tests |
| `node confirm-local-gates-b100.mjs unit b102` | 7,452 PASS, 227 skipped; 892 files PASS, 10 skipped |
| `node confirm-local-gates-b100.mjs typecheck b104` | PASS |
| `node confirm-local-gates-b100.mjs lint b104` | Touched-source lint PASS |
| `node /private/tmp/nailiq-sms-waitlist-publish-lSILOf/verify-clean.mjs build b105 /private/tmp/nailiq-current-main-combined-iBPOnd/repo` | Default Turbopack build PASS; 61/61 static pages; empty local base unchanged |
| `node confirm-transaction-final-b106.mjs` | 20 real PostgreSQL scenarios and exact ACL gate PASS; entire transaction rolled back; base unchanged |
| `node confirm-concurrency-b101.mjs` | Ten-way same-SID race and completed replay PASS, then FAIL at fixture overlap |
| `node confirm-concurrency-continuation-b103.mjs` | Prior race ledger preserved; observed blocking lock, terminal drift and replay PASS; no next-appointment event or log |
| `git diff --check` | PASS |
| `node confirm-blank-history-b107.mjs b108` | Fresh blank PostgreSQL: 550 migrations, exact repository schema parity, ACL and 20 rollback scenarios PASS |
| `node confirm-local-gates-b100.mjs unit b112` | After full-URL fix: 7,454 PASS, 227 skipped; 892 files PASS, 10 skipped |
| `node confirm-local-gates-b100.mjs typecheck b113` | After full-URL fix: PASS |
| `node confirm-local-gates-b100.mjs lint b113` | After full-URL fix: touched-source lint PASS |
| `node /private/tmp/nailiq-sms-waitlist-publish-lSILOf/verify-clean.mjs build b111 /private/tmp/nailiq-current-main-combined-iBPOnd/repo` | After full-URL fix: default Turbopack build PASS; empty local base unchanged |
| `node --require=/private/tmp/nailiq-masterplan-combined-local-ojeco5/network-guard.cjs sms-confirm-http-b109.mjs b109` | Real HTTP reproduction FAIL after 3 passing cases: tampered-query signature accepted; retained |
| `node --require=/private/tmp/nailiq-masterplan-combined-local-ojeco5/network-guard.cjs sms-confirm-http-b109.mjs b110` | Corrected code/new build/fresh synthetic clone: 14/14 actual local HTTP scenarios PASS |
| `node --require=/private/tmp/nailiq-masterplan-combined-local-ojeco5/network-guard.cjs sms-confirm-http-b109.mjs b114` | Atomic-OFF follow-up: 7 cases PASS, then harness canonical-phone allowlist mismatch FAIL; retained |
| `node --require=/private/tmp/nailiq-masterplan-combined-local-ojeco5/network-guard.cjs sms-confirm-http-b109.mjs b115` | Corrected harness/new owned clone: 14/14 atomic-OFF, legacy no-match and durable consent HTTP scenarios PASS |
| `node confirm-local-gates-b100.mjs unit b116` | With 24 new actual-HMAC regressions: 7,478 PASS, 227 skipped; 892 files PASS, 10 skipped |
| `node confirm-local-gates-b100.mjs typecheck b117` | After new HMAC regression coverage: PASS |
| `node confirm-local-gates-b100.mjs lint b117` | After new HMAC regression coverage: touched-source lint PASS |
| `node confirm-advisors-b118.mjs` | FAIL before baseline query: invalid macOS network-sandbox IP syntax; artifact `b118` retained |
| `node confirm-advisors-b118.mjs b119` | Actual CLI 2.117.0 security/performance advisors before/after on a new owned local clone: zero new WARN/ERROR PASS |

Database scenarios cover exactly-once evidence, completion replay, action/body/
caller/destination mismatch, unverified sender/account, malformed SID, stable
not-found outcome after a booking appears, ambiguity beyond five candidates,
stable ambiguous replay, late unique-log failure rollback, already-confirmed
no-op, actual browser roles denied, service/JWT boundaries, soft deletion, and
preserving an existing confirmation timestamp. The SQL fixture itself does not
prove concurrency or HTTP signatures; those evidence layers stay separate.

The first full unit run `b100` had 7,435 PASS / 17 FAIL / 227 skipped. One failure
was the mutation test still using the old 614 function count; the other sixteen
were local listener `EPERM` failures (Square deadline and Mailpit tests).
After the one literal fix and allowing loopback listeners while retaining the
outbound network fence, `b102` passed. No unrelated Square implementation or
timeouts were changed. Both logs are retained.

The first concurrency script failed because its synthetic drift bookings
overlapped an existing fixture on the same technician. The exclusion safeguard
was not weakened. Continuation `b103` first checked the exact owned synthetic
state and original receipt, then used non-overlapping dates. This is a corrected
fixture run, not an erased first-attempt PASS.

Metadata rehearsal `b99` measured exactly +1 function and no other object
delta; role reachability remains 57/79/236. The candidate contract is 615 app
functions, based on the already-green blank CI baseline plus the local delta.
At this earlier metadata-only stage, a fresh full-history blank rehearsal was
NOT PROVEN. Follow-up `b108` now proves the local PostgreSQL history and exact
615 app-function contract with all 550 migrations, including this fifth one.
Local clone total-object counts include extension objects and must not be
mistaken for the filtered release-contract counts.

The initial blank run `b107` stopped at migration 344 because its harness did
not create the platform's `supabase_realtime` publication. Its failure artifact
is retained. Run `b108` used a new empty PostgreSQL cluster with that empty
publication and logical WAL enabled; no application migration or permission
was weakened. It had no network, exposed ports or live data. SQL scenarios ran
inside rollback and left all salon, booking, auth-user and receipt counts zero.
Both owned temporary rehearsal containers were removed; evidence remains.
The auth functions were the repository's bare-Postgres bootstrap stubs, not
GoTrue. Therefore this proves local migration history, not hosted Supabase Auth,
new-head CI, advisors or a provider/Production runtime.

Real HTTP follow-up `b110` used the rebuilt `b111` Next production server, actual
HMAC validation, actual local database token lookup, PostgREST and PostgreSQL.
Neither the HTTP adapter nor its signature or confirmation RPC was mocked.
Cases include wrong HMAC, wrong content type, oversized forms, query tampering,
correct full-query signature, unchanged exact replay, completion/retry pinned
to its original appointment, body/action mismatch under the same SID, six-way
parallel confirmation, injected transport failure before commit, dropped HTTP
response after commit followed by retry, unverified account and cross-salon
ambiguity. Fault injection is local and explicit, not an actual provider outage.

The original source clone and empty base retained identical row hashes/counts.
The test clone had zero outbound delivery attempts and auth users, both salons'
outbound flags OFF, zero database deadlocks and no unexpected gateway paths.
Only owned application/gateway processes and the temporary PostgREST sidecar
were stopped; the isolated test clones and red/green evidence were retained.
This is local HTTP/database proof, not hosted callback ingress, real Twilio
delivery, scheduler, customer UI or physical-device/human-pilot acceptance.

Compatibility follow-up `b115` deliberately sets both atomic adapters to false
on the same application build. It validates encoded/ordered/repeated query
parameters with real HMAC, rejects tampered URLs before selection or consent
writes, retains STOP/START priority over booking commands and produces empty
TwiML without an extra SMS. Actual consent persistence survives exact retry,
delayed STOP replay after START, six simultaneous STOP requests and a lost
committed START response. Five consent events are recorded exactly once; the
booking/event/notification/inbound-booking-receipt snapshot is unchanged.
Valid YES/NO commands use the legacy selector for a synthetic phone with no
appointments, with and without a query; they do not invoke either new atomic
RPC. This does not claim full legacy assignment/cancellation mutation safety:
the previously reproduced legacy retargeting defect still needs the approved
atomic rollout.

Run `b114` failed because the private gateway expected a plus-prefixed phone
filter but `toCanonicalPhone` correctly uses digits without a leading plus.
The harness was corrected to that exact single synthetic phone/filter; no
application query, RLS, grant or gateway path was broadened. Its red evidence
remains. Follow-up `b115` uses a new clone, retains original source/base hashes,
has zero outbound delivery attempts/deadlocks and stops its owned processes.

The repository-source candidate now also contains 24 regression tests using the
actual signature verifier across YES/NO/STOP/START, both flag states and valid/
tampered query URLs. Their persistence and domain collaborators are mocked;
the separate actual HTTP/database tests supply those evidence layers. Latest
read-only GitHub check confirms PR #1441 remains OPEN/Draft at `ab98bc2c`, not
the unpublished local confirmation candidate.

Local advisor comparison `b119` removes only the new confirmation function in
its own clone for the baseline, then applies the exact migration transaction
and compares the full results. CLI `db advisors --db-url <local-clone> --type all
--level info --fail-on none --output-format json` runs its lint SQL inside a
rollback transaction. The CLI has a clean temporary home and a macOS network
sandbox permitting outbound only to the local PostgreSQL port; it cannot use
a linked-project credential or send telemetry outside the machine.

Both baseline and candidate report 759 INFO and 73 WARN, with zero ERROR and
zero added/removed findings. These existing WARN are not erased, ignored as a
global PASS, or represented as hosted/Production cleanliness. The new RPC's
empty search path and exact service-only ACL are rechecked; `PUBLIC`, `anon`
and `authenticated` cannot execute it. Source/base and clone row hashes remain
unchanged. Its owned clone and artifacts remain for inspection.

The first advisor run `b118` was stopped by macOS before the lint query because
the sandbox profile used an unsupported literal-IP address syntax. `b119`
uses the supported `localhost:54322` filter and a fresh clone, without allowing
remote network traffic. Both failure and success artifacts remain. Local
advisors therefore no longer lack evidence; hosted QA advisors and the new
head's hosted CI/Preview remain unproven until the publication/migration
approval below.

## Hosted QA migration — approved execution

On 2026-10-01, after the explicit publication/QA approval, connected Supabase
identified disposable project `uhpzafoiifupyypkcwln` as healthy. Its two salons
are synthetic; Preview's four Supabase variables are branch-scoped to this
project and all 19 provider kill switches remain OFF. No Production setting
was changed.

Applied only `20261001114926_add_atomic_inbound_sms_confirmation_receipts.sql`
(SHA-256 `e8eeeb7681682da36e8d9c30da426fb5a87943cb78b033e8e3ecde338b494ffb`)
inside a transaction with 3-second lock and 30-second statement timeouts.
Supabase MCP recorded QA history version `20261001144157`; this maps to the
source file above and does not rename it in Git. Read-back function signature
is `confirm_booking_from_signed_sms(text,text,text,text,text)`, definition MD5
`6567624dc424050ca76550f2fe11191d`. It is SECURITY DEFINER with empty search
path, EXECUTE denied to PUBLIC/anon/authenticated and allowed to service_role.

Executed the checked-in 20-scenario SQL fixture on hosted QA inside
BEGIN/ROLLBACK, without HTTP/provider calls. The explicit terminal result was
`20 scenarios PASS; rollback follows`. After rollback the existing salon,
booking, waitlist, auth-user, platform-settings and inbound-receipt fingerprints
are unchanged; fixture salon collisions and leftover fixture salons are zero.
QA still has two synthetic salons, three bookings, four auth users and zero
inbound booking receipts. This is SQL/RPC proof, not hosted HTTP proof.

Security advisors: 77 INFO / 21 WARN / 0 ERROR before and after. Performance
advisors: 405 INFO / 83 WARN / 0 ERROR before and after. Per-finding comparison
found zero added or removed findings. Existing warnings remain outside this
confirmation migration's delta; this is not a claim the database has no warnings.

## Hosted blocker and remaining boundaries

The new Preview POST callback is denied before the handler. Read-only firewall
inspection found a matching stale-deployment writer deny rule whose host
allowlist excludes this Preview. This supports the diagnosis but does not
provide a per-request rule-ID log. No WAF rule was edited, bypassed or published.
The subsequent inbound malformed-request cases were not run after this denial.

Before hosted confirmation can be accepted:

1. Complete the approved commit/push of only this confirmation batch into
   PR #1441, keep Draft, and verify a QA-only Preview at the resulting head.
2. QA migration, metadata, ACL/advisors and synthetic SQL rollback are now
   PASS as described above; no Production migration is authorized.
3. If still necessary, review a narrowly scoped WAF change for the exact QA
   deployment host and Twilio callback paths; do not permit generic writers or
   alter Production behavior. No such change is approved or performed here.
4. Enable the two atomic adapters only for the approved QA branch, then test
   signed synthetic HTTP requests, durable receipts, retries and race behavior
   without real provider delivery. Restore the QA adapter flags OFF afterward.

Actual provider callback/delivery, reminder scheduler, STOP/START end-to-end,
physical devices and the two human pilots still require their own evidence.
Local PASS and Preview READY do not close P1-01 or the Master Plan.

## Preservation and rollback

All sixteen unrelated files match their preflight SHA-256; the two unrelated
staged files remain staged and untouched. The shared acceptance tracker was
not edited because it contains another task's staged work. No new commit/push,
Ready transition, merge or Production deployment occurred in this local batch.
QA hosted before/after row snapshots from callback probing are unchanged.
No provider, cron, SMS, email, call or payment was invoked.

Rollback is flags OFF first. Removal of the new function requires separate
approval; never delete the populated shared receipt ledger. The previous
approved four QA migrations and earlier failed evidence remain intact.
