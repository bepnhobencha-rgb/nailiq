# TurnIQ M4I — Local Browser Story

Status: `LOCAL_BROWSER_TESTED_NOT_QA`

TurnIQ remains behind `turniq_trust_engine_enabled`; every salon remains OFF.
This milestone did not commit, push, apply QA/Production, mutate a real booking,
call a provider or send a notification.

## Outcome

The real Receptionist Center group-plan component now has a synthetic browser
story for the supervised staggered flow. The fixture is in memory and exposes
no database, auth, payment or messaging client.

The local browser proved four paths:

1. `happy`: compare all three timing intents, choose Smart Wave, review both
   guests, atomically confirm the group, and show exactly two Fairness Receipts.
2. `stale`: reject an expired/drifted comparison before review; no booking is
   represented as changed.
3. `refresh_failure`: preserve the authoritative committed-plan success even
   when the follow-up read fails, so the receptionist is not encouraged to
   repeat the mutation.
4. `offline`: keep the party visible but disable compare and plan creation.

## Exposure boundary

- The route exists only under `/e2e-local/turniq-supervised-staggered`.
- Both proxy and page require the existing production-aware demo/E2E bypass
  guard (including its explicit test flag and positively identified local/test
  target) plus a loopback `Host` (`localhost`, `127.0.0.1` or `::1`).
- A non-loopback host cannot use the local bypass and the page returns 404.
- Fixtures use synthetic UUIDs and names only; no PII or provider path exists.

## Evidence

- Browser happy path: PASS; compare → choose → review → confirm → two receipts.
- Browser stale path: PASS; fail closed and no review plan.
- Browser post-commit read-back failure: PASS; committed success remains shown.
- Browser offline path: PASS; both mutation entry points disabled.
- Non-loopback request: HTTP 404 PASS.
- Focused component/security tests: 35/35 PASS.
- Full unit: 670 files passed, 1 skipped; 4,088 tests passed, 1 skipped and
  7 todo.
- TypeScript: PASS.
- Lint: 0 errors; 42 pre-existing warnings outside M4I.
- Next.js production build: PASS; existing Edge Runtime warnings remain.

## Not proven

- Disposable QA database, Preview or CI browser execution.
- Production, live salon or pilot behavior.
- Provider delivery, customer notification or real booking mutation.

The next safe boundary is a separately authorized disposable-QA and Preview
story using synthetic tenant data, all provider kill switches ON and TurnIQ OFF
for every real salon.
