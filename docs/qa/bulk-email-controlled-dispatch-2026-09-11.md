# Bulk Email Controlled Dispatch — QA Evidence

Date: 2026-09-11 UTC. Scope: local code plus Supabase QA disposable
`osdqutwunokiielbairj`. Production and live salons were not changed. No email,
SMS, call, payment, or external provider was invoked.

## Safety model

- Dispatch defaults to `locked` and still requires the independent salon flag,
  application environment gate, and provider-mode gate.
- Only an authenticated Owner/Admin server action may request a transition.
  Each database control RPC independently rechecks Owner/Admin membership and
  is executable only by `service_role`.
- Canary claims are capped in the database, not only in the UI. Failed
  pre-acceptance retries keep their canary cohort and cannot expand the cohort.
- Bulk release requires completed canary evidence, zero adverse canary outcomes,
  and one explicit Owner/Admin action.
- Pause blocks new claims. Existing leased attempts retain their exact receipt
  boundary and may finish; resume returns to the prior stage.
- QA runtime mode is provider mock only. A simulation writes durable receipts
  but never contacts Resend.
- Expired worker leases retry with the same provider idempotency key. At the
  third expired attempt they become `unknown` for manual review instead of
  being resent or silently blocking forever.

## Local verification

- Focused Vitest: 23/23 PASS.
- TypeScript: PASS.
- Focused ESLint: PASS.
- Next.js production build with Webpack: PASS. The default Turbopack command
  rejected the isolated worktree's external `node_modules` symlink before
  compiling application code; this is a local worktree setup limitation.
- Diff whitespace check: PASS.

## Hosted QA synthetic scenario

A synthetic four-recipient campaign used canary size 2 and configured batch
size 1.

1. Draft, frozen consent audience, Owner approval: PASS.
2. Start-canary retry returned the same active stage and created only one start
   event: PASS.
3. A request for 100 recipients claimed only one because the database enforced
   batch size 1: PASS.
4. Exactly two recipients entered the canary cohort; both were completed as
   simulations: PASS.
5. Wrong actor bulk release returned `forbidden`: PASS.
6. Owner bulk release recorded actor/time and opened bulk stage: PASS.
7. Pause returned zero new claims; repeated pause was idempotent: PASS.
8. Resume returned to bulk; remaining recipients completed as simulations:
   PASS.
9. Final truth was 2 canary + 2 bulk + 4 simulated, exactly one campaign
   completion event: PASS.
10. `anon` and `authenticated` cannot execute start/release RPCs;
    `service_role` can: PASS.
11. An expired lease was reclaimed with the same recipient and idempotency key;
    canary size remained one: PASS.
12. A third expired lease became `unknown`, produced one terminal recovery
    event, returned zero new claims, and blocked bulk release with
    `canary_needs_review`: PASS.

Synthetic customer rows and recipient rows were removed after verification.
The two immutable, PII-free QA campaign/event evidence sets remain by design. The
synthetic salon's temporary email and dispatch switches were restored OFF.

## Vercel Preview verification

- Draft PR: `#1400`; source commit: `61bcc49d`.
- Preview deployment `dpl_2GuuexGbWW6HovNYzjMBejCysGKA` reached `Ready` at
  `https://nailiq-fwajnlnjo-bepnhobencha-2588s-projects.vercel.app`.
- The branch-specific encrypted configuration resolves to Supabase QA disposable
  `osdqutwunokiielbairj`; email, SMS, call, payment, and provider switches remain
  OFF. Bulk email provider mode is `mock` with simulation enabled.
- A temporary synthetic QA Owner opened the Marketing route successfully. The
  page rendered the campaign creation flow, consent review, Owner approval step,
  and the explicit QA simulation truth banner.
- The temporary Owner, salon, and browser session were removed after the UI
  check. No customer, provider, notification, or Production data was used.

## Not proven in this phase

- No real provider acceptance, delivery, bounce, complaint, unsubscribe, or
  inbox rendering was tested.
- Nothing here authorizes Production migration, merge, deployment, live-salon
  activation, or customer email.

Result for the approved local/QA/Preview phase: **PASS**.
