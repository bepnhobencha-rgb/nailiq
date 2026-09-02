# TurnIQ M1A Deterministic Single-Customer Engine

Status: `implemented locally` and `tested locally`. It is not integrated,
deployed, production-verified, enabled for a salon, or pilot-proven.

## Runtime boundary

`src/shared/turniq/singleCustomerEngine.ts` is a pure decision module. It has no
Supabase, Next.js, notification, payment, AI-model, or provider dependency. It
does not mutate its input. The decision timestamp comes from the versioned
snapshot, never from `Date.now()`.

The only asynchronous operation is browser-compatible SHA-256 over canonical,
PII-minimized input material. Reordering candidate or resource rows does not
change the decision fingerprint.

## Eligibility order

The engine fails closed and records deterministic reason codes for:

1. not checked in or inactive;
2. busy;
3. approved break or temporary hold;
4. incomplete capability data or skill mismatch;
5. insufficient occupied time, including service buffer, before the next
   appointment;
6. refusal penalty or manager safety hold;
7. unavailable required resource;
8. future policy or stale salon-local business-day snapshot.

Being skipped does not change queue position. This engine returns a decision;
it has no queue mutation capability.

## Requested-technician precedence

An eligible request with recorded source, actor, and timestamp takes precedence.
`staff_entered` retains the trust label `customer_claim_recorded`; it is not
described as independently verified. `legacy_unknown` is retained for migration
truth but never receives requested-technician precedence.

If the requested technician is not eligible, the engine records
`REQUESTED_TECH_UNAVAILABLE` and safely falls back to normal ranking.

## Fairness-band ranking

Opportunity credit is:

`service credit since check-in + fairness baseline at check-in`

All values are non-negative safe integer cents. The configured fairness band is
limited to the PRD range CAD $0–$100.

To avoid a non-transitive pairwise comparator with three or more technicians,
the engine creates deterministic tiers anchored to the lowest eligible credit:

`tier = floor((credit - minimum eligible credit) / (fairness band + 1 cent))`

It then ranks lexicographically by:

1. lower fairness tier;
2. lower active queue position;
3. code-point-stable staff ID.

This makes a difference equal to the configured band “inside” the band. With a
CAD $20 band, $100 and $120 use queue order; $100 and $120.01 prefer $100.

## Explanations and privacy

Every eligible but unselected technician receives one selection reason such as
requested-technician precedence, higher opportunity credit, later queue within
the band, or stable ID tie-break. Ineligible technicians retain operational
skip reasons.

The default client projection excludes exact fairness credit, fairness tier,
and the authorized internal trace. `explainWhyNotMe` uses only deterministic,
privacy-safe operational language and never exposes peer revenue or tips.

## Intentionally not included in M1A

- feature-registry wiring or salon activation;
- database policy/ledger/RPC/migration;
- check-in PIN or shift mutation;
- booking/resource mutation or recheck transaction;
- group constrained matching;
- Receptionist Center UI;
- shadow/replay persistence;
- offline writes.

Those remain separately reviewable milestones. Passing M1A tests is not
Production or salon-pilot evidence.
