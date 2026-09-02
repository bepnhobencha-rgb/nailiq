# TurnIQ M6 Pilot Runbook

Status: local implementation and rehearsal contract. This document does not
enable TurnIQ, migrate a database, contact a provider, or prove a salon pilot.

## Evidence labels

- **Implemented locally:** code exists in the current worktree.
- **Tested locally:** the named automated command passed against synthetic data.
- **QA-proven:** migrations and authenticated flows passed in a disposable QA tenant.
- **Deployed:** code/schema is present in the named environment but can remain OFF.
- **Production-verified:** read-only checks prove the deployed version and schema.
- **Pilot-proven:** representative salon baseline, shadow, supervised and live stages passed.

Never substitute one label for another.

## Pilot sequence and rollback boundary

1. **Baseline:** TurnIQ flag OFF. Record normal assignment latency, wait range,
   walk-aways, owner interventions and disputes for at least representative busy
   shifts. Rollback is a no-op because TurnIQ does not control assignments.
2. **Shadow:** flag enables read-only recommendation/replay only. Compare the
   recommendation to actual staff choices. Rollback by disabling the salon flag;
   preserve every decision and comparison receipt.
3. **Supervised:** authorized staff see recommendations and explicitly confirm.
   Owner handles only Exception Inbox items. Rollback by disabling the salon
   flag and returning to the existing Receptionist Center workflow.
4. **Live pilot:** only after the gates below pass and the Owner explicitly
   approves the exact salon. Rollback immediately on any duplicate assignment,
   lost offline command, tenant/role leak, unexplained money mismatch or unsafe
   appointment/resource conflict.

Never drop TurnIQ policies, events, command receipts, Fairness Receipts,
offline reconciliation rows or disputes during rollback.

## Preflight gates

- Per-salon `turniq_trust_engine_enabled` remains default OFF and is absent/false
  for every non-pilot salon.
- Migrations apply cleanly to a blank/disposable database and pass metadata,
  ACL/RLS and security-advisor checks.
- Owner/Admin can pair exactly one Primary Offline Device. A second or revoked
  device is read-only when disconnected.
- Booking, shift, skill, next-appointment gap and resource validation remain
  authoritative in the atomic server transaction.
- SMS, email, push, voice and payments are never claimed successful offline.
- Outbox survives reload and reconnect; same command/fingerprint returns one
  committed result; a different fingerprint becomes an explicit conflict.
- Accessibility has no serious/critical WCAG A/AA issue in the seeded tablet demo.
- The designated physical iPad/iPhone Safari device opens `/turniq/offline`,
  reloads while disconnected and shows the encrypted pending count. Automated
  Playwright WebKit cannot prove this navigation because its offline mode aborts
  with an internal engine error; Chrome production-build coverage is not a
  substitute for the physical-device gate.
- Existing relevant unit, security, type, lint, build and browser suites pass.

## Mandatory 60-second owner demo

Use only the seeded local Salon A harness. Within 60 seconds, a first-time owner
must identify: next technician, why, wait range, and whether Owner action is
needed. Then prove, without hidden edits:

1. Add one walk-in and receive the deterministic recommendation.
2. Show an earlier technician skipped for appointment-gap safety without losing place.
3. Show `staff_entered` as a recorded customer claim, not verified intent.
4. Complete the service and create exactly one Fairness Receipt.
5. Replay with another fairness band without live mutation.
6. Lose connectivity on the designated device, persist an encrypted command,
   reload, reconnect and observe one sync with no loss or duplicate.
7. Delete/corrupt the local encryption key and prove all offline writes lock.

Fail the experience gate if the owner calculates the order, inspects exact peer
earnings, navigates multiple admin pages, or verbally explains the fairness rule.

## Pilot observation review

The Owner/Admin trust summary exports dated JSON containing assignment latency,
unique completed customers, wait p50/p90, acceptance, overrides, owner-free
turns, observed Owner decision time, request sources, exceptions, disputes,
offline conflicts and opportunity distribution. The initial walk-away measure
is explicitly labeled as a cancelled-walk-in proxy; do not treat it as verified
customer intent. Server evidence alone also cannot prove zero lost device
commands, so the export keeps offline-loss evidence incomplete until device
reconciliation and the representative pilot pass. Exact peer financial values
never appear in technician views. Targets are hypotheses until the real baseline
is complete.

Go-live requires zero duplicate assignments, zero lost offline commands, full
override/request provenance, a successful rollback rehearsal and explicit Owner
approval of the exact salon and effective business date.

## Incident recovery

1. Stop new TurnIQ control by setting the one pilot salon flag OFF through the
   approved release-control path.
2. Revoke its Primary Offline Device lease. Do not delete its outbox or evidence.
3. Use current Receptionist Center booking/resource truth as operational truth.
4. Export the Owner trust summary plus open reconciliation/Exception Inbox items.
5. Resolve each conflict explicitly: keep server truth or safely re-enter the
   local action. Never use last-write-wins.
6. Rehearse re-enable only in disposable QA, then repeat approval gates.
