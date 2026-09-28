# PR1429 Preview browser boundary — 2026-09-25

PR1429 is still Draft. The three relevant heads are distinct:

- `7565f592`: first feature Preview. Synthetic login returned an indeterminate completion message; runtime logs showed GET `/login` but no POST.
- `5dff0ecc`: schema parity correction. CI Build & Type Check **failed** because exact-shape regression fixtures still expected the old counts. Preserve run 36185577254 as a real failure.
- `6cf23209d98919cfa45e6f333f798208dee05034`: corrected regression fixtures. Git-backed QA Preview `dpl_3rKYbEkE6ymBzyeoGMBuepUtYn5v` was READY at the exact SHA. Branch-only QA configuration was present before deployment. Local focused regression 14/14 PASS, security folder 1422/1422 PASS, typecheck PASS. CI Build & Type Check, Security Audit, Smoke, visual regression, i18n and several browser jobs passed; full E2E was still pending at the time of this record.

## Temporary browser-access rehearsal

The active Vercel WAF stale-deployment-writers rule blocked POST on the new Preview host. Its active version had five OR groups; a separate unpublished user draft had only two and must not be published accidentally. After explicit approval, the exact new Preview hostname was added to the active rule's first four host exclusions only. The fifth, payment-reconciliation-cron group was unchanged. Before publishing, the draft was checked field-for-field against active-plus-one-host. The temporary rule was published as WAF version 15 and the pre-existing user draft was immediately restaged unchanged.

In Chrome computer use against that exact QA Preview:

- A freshly created synthetic QA owner logged in and opened a future synthetic booking in Receptionist Center. No real salon or Production account was used.
- The booking drawer showed separate “Text save-card link” and “Email save-card link only” actions. The synthetic Square integration was disabled; outbound email, SMS, call, payment, provider and dispatch kill switches stayed OFF.
- Pressing the email-only action twice showed “Email sending was not confirmed … No SMS sent.” It never displayed “Email accepted for sending.” QA receipt count remained zero. The receipt claim intentionally stops before insertion while `DISABLE_OUTBOUND_EMAIL=1`; this is a suppression test, **not** evidence of provider delivery or the successful-path receipt.
- Switching the same synthetic member to Nail Tech hid the send actions; the owner role was restored before cleanup.
- The exact synthetic booking, integration, membership, staff, service, salon, category and Auth user were deleted after confirming zero card-email receipts. The Chrome QA tab was closed.

The one-host WAF exception was then revoked. Published WAF version 16 matched the original active rule field-for-field, including the cron fence. The unrelated unpublished draft was preserved field-for-field with one pending update. Production deployment remained `dpl_93ZAvNVmmdpf48sMpLuifg3cTSVf` at SHA `006da9b322d3da154cb2f4bc36a491616957a631`; no app Production rollout, provider call or real message occurred.

## Remaining evidence boundary

Hosted QA verified the user-visible failure/suppression truth and role surface. It did not verify a real sending provider, inbox delivery or the successful receipt path because all outbound providers remained disabled. CI must finish on head `6cf23209` before Ready review. Do not label earlier failed CI or local tests as a hosted positive-path PASS.
