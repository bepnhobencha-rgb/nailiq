# SMS STOP/START HTTP-to-database acceptance — B61

Date: 2026-10-01. **TESTED LOCALLY**. Day 22: **NOT_CLOSED**.
P1-01 hosted/provider acceptance and the Master Plan remain **NOT_PROVEN**.

## Scope

This continues the [B60 production-mode local callback rehearsal](sms-callback-production-runtime-local-2026-10-01.md).
Candidate HEAD remains `e2680aa7a779448940ba597317e908c503089a66` with
preserved unpublished combined changes. No application source, migration,
policy, grant, provider setting, or hosted configuration changed in B61.

The real `/api/twilio/inbound` HTTP route, Next proxy/body parser, HMAC
validation, database credential lookup, consent helper and four actual RPCs
ran against PostgreSQL 17.6 through restricted local PostgREST. No API,
signature validator, credential lookup, or database operation was mocked.
The same full B60 default-Turbopack build ran with `next start`; this is a
**local production-mode process**, not a Production deployment.

The isolated clone `nailiq_sms_callback_http_20261001_b61` came only from
the owned synthetic B54 source. Account, sender, recipient, signing token
and hash material are synthetic. There are no auth users or real customers.
App and salon outbound SMS/email remain OFF. Loopback transport fencing and
the database allowlist remained enforced throughout.

## Results

**15/15 actual HTTP-to-database cases PASS**, zero external transport denials,
zero unexpected database routes. **56/56 contract tests in five files PASS**;
these mocked contracts are separate from the HTTP rehearsal, not provider proof.

| Case | Result |
| --- | --- |
| Invalid HMAC | 403, consent ledger unchanged |
| Signed STOP | 200, one durable applied event, suppressed state, empty TwiML |
| Exact STOP retry | 200, timestamps and state epoch unchanged |
| Same MessageSid changed from STOP to START | 503, immutable event unchanged |
| New signed START | 200, provider scope clear, correct next epoch |
| Delayed exact replay of old STOP | 200, cannot undo the newer START |
| Six parallel identical STOP requests | All 200, exactly one new event |
| Committed response lost | Real proxy drops one 200; explicit retry creates no duplicate |
| Signed wrong provider account | 503, no new event |
| Signed wrong sender | 503, no new event |
| HELP | Empty 200 TwiML, no duplicate reply or consent mutation |
| Body `CANCEL` without OptOutType | Durable provider STOP, no booking cancellation |
| Malformed MessageSid | 503, ledger unchanged |
| Unknown command | Empty 200 TwiML, no mutation |
| Wrong content type | 400 before token lookup |

Final state: five consent events, all applied, one provider-state row;
zero notification bookkeeping rows, auth users, new bookings or deadlocks.
All 272 unrelated target-table fingerprints remained unchanged after
fixture initialization, including every pre-existing booking, Waitlist,
claim receipt and salon-specific consent state. All 274 source-table
fingerprints and the empty root database were unchanged. Every owned
process and temporary PostgREST container stopped; app exit 143 is the
intentional SIGTERM teardown. Raw phone/body data are not stored in the
consent ledger; RPC phone hashing is the existing keyed-hash contract.

The HTTP test's empty TwiML means NailIQ does not add a duplicate response.
It does **not** prove Twilio sent its Advanced Opt-Out acknowledgement or
changed its carrier block list. Provider-side STOP/START remains a separate
authorized hosted acceptance gate. No carrier/provider request occurred.

## Verification and preservation

```sh
node --check /private/tmp/nailiq-current-main-combined-iBPOnd/sms-consent-http-b61.mjs
node /private/tmp/nailiq-current-main-combined-iBPOnd/sms-consent-http-b61.mjs
NODE_OPTIONS=--require=/private/tmp/nailiq-masterplan-combined-local-ojeco5/network-guard.cjs ./node_modules/.bin/vitest run src/app/api/twilio/inbound/route.spec.ts src/app/api/twilio/inbound/route.atomic-cancel.spec.ts src/app/api/twilio/inbound/route.booking-truth.spec.ts src/shared/reminders/__tests__/smsConsentSuppression.spec.ts src/shared/reminders/__tests__/inboundSmsCommand.spec.ts
git diff --check
git diff --cached --check
```

Do not blindly rerun: the target exists and generated evidence is write-once.
Artifacts: `sms-callback-http-b61.json`, `sms-callback-http-b61.log`, and
`combined-sms-consent-evidence-b61.json` under
`/private/tmp/nailiq-current-main-combined-iBPOnd`. Despite their historical
filename prefix, B61 tests **inbound consent**, not outbound delivery status.
The closeout pins the B60 receipt/report and B61 evidence without rewriting
prior red artifacts or the four imported staged files.

B60 closeout's first Node-child GitHub read failed to connect after its local
gates ran. This is retained in `closeout-sms-http-b60-initial-failure.json`.
A separate direct read-only `gh pr view` succeeded; sanitized metadata is in
`published-pr1441-b60.json`. Corrected closeout used that explicit snapshot:
PR #1441 OPEN/Draft, exact e2680 head, 24 SUCCESS and two SKIPPED contexts.
These published checks **do not** apply to the unpublished combined candidate.
No CI was rerun. B60 fresh typecheck, targeted lint and diff checks passed;
its full build is reused, not recounted as a new B61 build.

## Next boundary

The B60 and B61 local HTTP gates are complete. The next release gate requires
scoped approval to publish the reviewed combined candidate and test it on
isolated hosted QA/Preview, including its exact pending migrations. It must
not reuse Production credentials or enable a Live salon. Real Twilio
delivery, actual scheduled reminders, hosted opt-out transport, physical
devices and two-salon first-human 7–14-day pilot evidence remain NOT PROVEN.

No commit, push, hosted migration, deploy, real booking, SMS, email, call,
payment, provider request, or Production/salon mutation occurred in B61.
