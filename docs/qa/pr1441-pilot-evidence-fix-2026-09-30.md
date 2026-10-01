# PR #1441 — pilot evidence fix, 30/09/2026 Vancouver

Scope: P1-07 evidence tooling and the local build verification gate. This is
not a pilot completion, rollout approval, or change to Master Plan goals.

## Exact state and preservation

- GitHub PR #1441 read twice: OPEN, Draft, head
  `1489fa2063b4ecfd3202211b386799d9c0e9bb54`, base
  `362dca4d028b40e3bcce52f67fac40fbc9caf07e`.
- Existing branch: `qa/masterplan-day21-pilot-kit-20260929` in
  `/private/tmp/nailiq-activity-delivery-truth-20260928`, same head. Its untracked
  WebKit evidence note and `error.log` were preserved. A separate build was
  observed running there; this turn neither changed nor stopped that process.
- Work prepared in a detached local clone at the exact PR head, under this
  chat's `work/nailiq-pr1441`. No new remote branch/PR, reset, force push,
  commit, push, PR-body update, merge, or deployment was performed.
- The Cloud-reported `6d6acfbf512a8041b61d2487d4321f771801ed57` is not present
  in the local object store or current PR head. Its described cohort parser
  change was reconstructed against current code; no claim of identical commit
  content or recovery of all Cloud files is made.

## Reproduced defects and fixes

1. Parser accepted S0/S3/S999/S01 in salon or participant salon fields.
   The evaluator already prevented cohort PASS; the parser boundary was too
   permissive. It now uses `z.enum(PILOT_SALON_CODES)`, sharing the evaluator's
   S1/S2 allowlist. Errors still expose field paths only, never input values.
2. Missing evidence hid decisive failures: help count 2 plus another null;
   one salon refusing to continue plus another unanswered; observed days 6/15
   plus another null; and an already unreachable 80% success rate plus an
   incomplete task observation all returned NOT_PROVEN instead of FAIL.
   Known failures now take precedence within valid participant/record sets.
   For tasks, the maximum possible qualifying count determines whether failure
   is already certain. Missing observations remain NOT_PROVEN when 80% is still
   possible. Missing/duplicate identities do not establish a usable denominator.

No thresholds, cohort, feature flags, UI, booking source, workflow, lockfile,
database, provider behavior, or payment behavior changed. This tool still
cannot authenticate human observers or certify self-reported measurements.

## Verification

- Before fixes: parser regression suite 4 failed / 9 passed; evaluator
  regression suite 5 failed / 15 passed. Failures matched the defects above.
- After fixes: 2 pilot suites, **33/33 PASS, 0 skipped**.
- Independent review of task bounds: 445 combinations across 3–12 people,
  explicit failures and missing observations; no false PASS or changed threshold.
- 4 existing mocked booking regression suites: **32/32 PASS, 0 skipped**,
  including pending request-ID cleanup, pending Try-On attachment, tab
  idempotency, card capability timeout, and independent reconciliation failure.
  The injected `Error: lost` diagnostic is expected in its passing test.
- Typecheck: PASS, run before build. ESLint on four touched TypeScript files:
  PASS, 0 errors/warnings. `git diff --check`: PASS.
- `npm audit --package-lock-only --audit-level=high`: exit 0, **0 vulnerabilities**.
  This is a current npm lockfile audit; no separate new pnpm audit is claimed.
- Synthetic CLI: formula PASS / gate NOT_PROVEN / exit 1. Blank human CLI:
  formula and gate NOT_PROVEN, 0/0, exit 1. Invoked through `node --import tsx`
  to avoid the tsx CLI IPC requirement in the restricted environment.
- Default `npm run build` (Next 16.3.4 Turbopack): **PASS, exit 0**, compile
  8.0 seconds, TypeScript 20.7 seconds, 61/61 static pages. Existing Edge
  Runtime deprecation/static-generation warnings remain. The first sandboxed
  build stalled at optimization; its own verified PIDs were stopped (exit 143).
  The identical source, command and dummy environment completed outside the
  sandbox. This supports an environment-specific stall, not proof of a
  universal native-toolchain fix or the Cloud build's root cause. No bundler
  configuration, package versions or timeouts were changed.

Dependencies were installed from the unchanged lockfile into a real local
node_modules directory (no out-of-root symlink). Initial sandbox npm download
failed DNS; approved public-registry access completed installation. No local
secret files were copied. Checks used an allowlisted environment; build used
dummy keys, loopback database URL, outbound SMS/email/calls disabled, and no
provider credentials. A build is not a runtime/provider/Production test.

## CI and WebKit evidence

Read-only GitHub verification on remote SHA `1489fa2063b4ecfd3202211b386799d9c0e9bb54`:

- CI run [36677607688](https://github.com/bepnhobencha-rgb/nailiq/actions/runs/36677607688): SUCCESS.
- E2E run [36677607669](https://github.com/bepnhobencha-rgb/nailiq/actions/runs/36677607669): latest attempt SUCCESS.
  Latest jobs include non-RC `109780630512`, receptionist Chromium
  `109780630741`, mobile, auth/recovery, smoke and visual SUCCESS. MQA-0148 and
  AI Triage are conditional SKIPPED. Successful job steps may also contain
  conditional skips; no skipped step is counted as executed.
- Handoff attempt 1 remains FAIL: mail catcher port 54324 occupied and a
  WebKit booking-submit timeout. Attempt 2's 10/10 WebKit result is historical
  log evidence from the handoff, not a new local browser run.
- The preserved local trace report identifies RPC body `success=true`,
  `code=booked`, `idempotent=false`, with UI still Submitting. It has no DB
  read-back and cannot establish the native renderer cause. This turn read
  that report and current source/regression tests; it did not re-download or
  reinterpret raw trace payloads as new evidence.
- Existing non-blocking acknowledgement/Try-On fix remains present and its
  mocked regressions PASS. No blind timeout increase, resubmission after commit,
  infinite CI retries, or unsupported booking-source patch was made.

The uncommitted diff has **no CI, Preview, deployment, Production verification,
or pilot proof of its own**. CI above certifies only the current remote head.

## P0/P1 delta and next gates

This table reconciles `MASTERPLAN_ACCEPTANCE_CURRENT.md` and day-21/day-22
records, preserving their historical scope. Production rows were not rechecked
against Live in this turn; missing evidence is not a newly proven software bug.

| Item | Evidence/environment/date | Missing gate | Who / next safe step |
|---|---|---|---|
| P0-01 | #1401/#1404 fixes and synthetic diagnostics; September historical QA | Causal attribution for historical 503s | Engineering: correlate retained request/stage/SHA logs; never reproduce on Live |
| P0-02 | Day 2/3 hosted QA, 22/09: signup/OAuth/defaults/cleanup PASS | New owner/device and Production/pilot proof | Owner/QA: planned human return-login observation; no duplicate signup patch |
| P0-03 | Historical #1417 merge `7c5fad5`, migration `20260921170000`, ACL/advisor PASS; 21–22/09 | WAF false-positive observation; enforce not approved | Engineering: retain log-only and collect authorized read-only traffic evidence |
| P1-01 | 24/09 one QA email delivered; day-22 notes #1439 Draft/CI green (not refreshed here) | NailIQ SMS canary/callback/terminal receipt, reminders/opt-out | Platform owner + QA: separately approved isolated provider test; previous one-email permission spent |
| P1-02 | #1408 QA/Sandbox evidence, 14/09 | Current Live card exceptions and owner decisions | Owner + QA: approved read-only snapshot and case-by-case decision |
| P1-03 | #1409/Day 5–6 QA, 15–24/09 | Novice timing, physical iPhone, five tasks | Pilot observer + actual participants; automation is not human proof |
| P1-04 | #1410, historical 60 browser PASS/3 SKIP and 32 unit PASS, 15/09 | Each salon's catalog/hours/staff/resource attestation | Each Hi-Lite owner + QA; do not mutate configuration to obtain a checkbox |
| P1-05 | #1411 trial/manual activation QA, 15/09 | Master Plan self-pay versus V1 manual commercial scope | Huy product decision; do not implement an unapproved payment model |
| P1-06 | #1413 merge `ae406a2419f924a6c0a1b209a61f018a1af6a04a`, historical deploy/20 tests PASS; 21–22/09 | Named incident responder and operational pilot rehearsal | Pilot lead + owners; technical deployment does not certify people |
| P1-07 | This local diff on `1489fa20`, 30/09; 33/33 tool tests PASS | Real two-salon observation 7–14 days, people mix, KPI/data integrity/continuation | Local tool fix complete; next publish boundary needs separate commit/push approval, human measurements stay blank |
| P1 build reliability | Current remote CI green; local result above | Native WebKit cause remains NOT PROVEN | Preserve attempt 1; next reproducible failure needs renderer/process timeline and regression proof |

Day 21 tooling is locally tested. Day 22 cohort preparation does not close
P1-07. Both salons remain Hi-Lite Head Spa and Hi-Lite Studio only. Human
forms, physical iPhone, 7–14 days and owner continuation remain NOT PROVEN.
Minh AI stays the daily summary in the agreed V1 scope; TurnIQ stays out of
this work. No Wix, Live customer, cron, notification, payment, or infrastructure
mutation occurred.

Next handoff: inspect the prepared diff, obtain explicit commit/push permission
for PR #1441, recheck its head before publishing, then use CI on the actual new
SHA. In parallel, the pilot lead needs named observer/participants, schedule,
salon attestation and incident ownership; do not fabricate or backdate them.

## Files in this batch

- `src/shared/pilot/pilotEvidenceFile.ts`: approved cohort input boundary.
- `src/shared/pilot/pilotAcceptance.ts`: decisive failure precedence.
- `src/shared/pilot/__tests__/pilotEvidenceFile.spec.ts`: parser regressions.
- `src/shared/pilot/__tests__/pilotAcceptance.spec.ts`: partial evidence invariants.
- `docs/qa/MASTERPLAN_ACCEPTANCE_CURRENT.md`: current local/remote checkpoint.
- This receipt: exact verification, limitations and P0/P1 handoff.

Prepared checkout:
`/Users/huytran/Documents/Codex/2026-09-30/prior-conversation-with-codex-conversation-role/work/nailiq-pr1441`.
The patch is against the exact remote head above; it has not been applied to
the separately active original worktree. Reconcile any newer changes before
applying/publishing it; never overwrite that worktree's unrelated files.
