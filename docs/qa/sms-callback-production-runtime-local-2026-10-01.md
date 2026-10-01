# SMS callback HTTP-to-database acceptance — B58/B59/B60

Date: 2026-10-01. **TESTED LOCALLY**, not deployed or provider-proven.
Day 22: **NOT_CLOSED**. P1-01: **NOT_PROVEN** at the hosted/provider gate.

## Scope

Candidate HEAD: `e2680aa7a779448940ba597317e908c503089a66`, detached,
with preserved unpublished combined changes. Published PR #1441 checks do
not certify this candidate. No application source or migration was edited
in these three runs; the change is verification methodology and this report.

The actual `/api/twilio/status` handler ran through Next's HTTP server,
proxy and form parser, then the actual credential lookup and receipt RPCs
through PostgREST into PostgreSQL 17.6. API and credential lookup were **not
mocked**. Fixtures and HMAC credentials were synthetic. The environment
fallback token was deliberately different from the database token, so a
successful signed callback proves the database lookup was used.

An allowlisted loopback database gateway admitted only the platform-token
lookup and three receipt RPCs. Every outbound provider channel stayed OFF;
the Node transport fence allowed only loopback/Unix sockets. No Twilio API,
SMS, email, call, payment, real customer, or hosted database was used.

## Retained red evidence and cause

- B58: 16 functional cases passed, but the whole run **FAILED**, exit 1,
  because the network fence blocked one external transport attempt.
- B59: diagnostic repetition retained the same overall **FAIL**. Bounded
  stack frames identify Next 16.3.8 `getVersionInfo()` in the Webpack
  development hot reloader. Installed source calls the npm dist-tags URL
  and catches the blocked fetch error. This is not a NailIQ SMS send.
- The fence was **not** relaxed. No destination was allowlisted, no
  dependency was patched, and neither failed artifact was overwritten.
- B60 changes the test to a fresh, full `next build` with default Turbopack
  and `next start` in production mode **on local loopback only**. This
  exercises the production runtime without development's update check.
  It is a different execution mode, not a hidden retry or Production deploy.

## B60 results

Full build: exit 0, 61/61 static pages, TypeScript build stage passed,
29.810 seconds. Actual production-mode HTTP runtime: **16/16 cases PASS**,
zero unexpected database routes, zero external transport denials.

| Case | Result |
| --- | --- |
| Wrong HMAC | 403; no receipt/status mutation |
| Signed query tampering | 403; no mutation |
| Nonterminal `sent` lifecycle event | 200; no invented delivery |
| Valid synthetic delivered callback | 200; durable universal and domain receipt |
| Exact replay | 200; original state/timestamps unchanged |
| Conflicting terminal callback | 409; original truth retained |
| Six simultaneous identical callbacks | Six 200 responses; one physical receipt |
| Signed message-SID mismatch | 409; no mutation |
| Signed failed callback, code 30003 | 200; failure stored in both ledgers |
| Callback before API acceptance completion | Terminal truth retained; late completion cannot regress it |
| Domain row missing after universal commit | First 503; fixture repair and explicit retry 200; no universal rewrite |
| Unknown attempt | 503; fail closed |
| Malformed correlation ID | 422; fail closed |
| Oversized form | 400 before credential lookup |
| Incorrect content type | 400; no mutation |
| Committed 200 lost before client receives it | One actual response drop; explicit retry 200; one durable receipt |

Final synthetic target: seven attempts, seven notification bookkeeping rows,
six applied domain receipts, zero auth users, zero bookings, zero deadlocks.
The unmatched-SID fixture remains accepted, without an invented receipt.
Notification rows are **not** messages sent. A synthetic `delivered` value
is **not** carrier delivery proof.

Source/root database fingerprints remain unchanged. Of 274 target tables,
271 unrelated tables are unchanged after fixture initialization; only the
three intended receipt/status tables changed during the callback scenarios.
Both salon outbound flags remain OFF. Owned app/proxy/gateway processes and
the temporary PostgREST container stopped at the end. Production-mode app
exit 143 is the intentional SIGTERM teardown, not a runtime failure.

## Commands and receipts

```sh
node --check /private/tmp/nailiq-current-main-combined-iBPOnd/sms-callback-http-b59.mjs
node --check /private/tmp/nailiq-current-main-combined-iBPOnd/sms-callback-http-b60.mjs
node /private/tmp/nailiq-current-main-combined-iBPOnd/sms-callback-http-b58.mjs
node /private/tmp/nailiq-current-main-combined-iBPOnd/sms-callback-http-b59.mjs
node /private/tmp/nailiq-current-main-combined-iBPOnd/sms-callback-http-b60.mjs
```

The B60 harness invokes `node node_modules/next/dist/bin/next build`, then
`node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3131`
with in-memory local credentials, provider kill switches, and the same
transport fence. Do not blindly rerun: owned clone targets already exist
and evidence files are write-once.

Sanitized JSON/log pairs `sms-callback-http-b58`, `sms-callback-http-b59`,
and `sms-callback-http-b60` are retained under the artifact directory above.
B59 retains diagnostic frames. B60 retains all case results, actual RPC
counts, preservation fingerprints and teardown. The closeout receipt
`combined-sms-http-evidence-b60.json` pins these artifacts and prior files,
and records focused contract tests/typecheck/lint/diff verification. The
contract tests use mocks and are not additional HTTP or provider cases.

## Remaining acceptance boundaries

Still **NOT PROVEN**: this combined candidate's hosted CI/Preview runtime,
hosted migration/advisor/ACL parity, actual Twilio callback transport and
carrier delivery through NailIQ, real scheduled reminder execution and
hosted opt-out end-to-end, physical-device acceptance, and first-human
7–14-day observations for exactly Hi-Lite Head Spa and Hi-Lite Studio.
This report does not close Day 22 or claim 100% of the Master Plan.

No commit, push, hosted migration, deployment, provider request, real
notification, or Production/salon mutation occurred in B58–B60.
