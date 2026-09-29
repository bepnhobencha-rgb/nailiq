# PR #1429 — hosted one-email QA evidence

Date: 2026-09-28 Vancouver / 2026-09-29 UTC. Scope: one synthetic salon and booking on disposable Supabase QA `uhpzafoiifupyypkcwln`, branch-specific Vercel Preview only. No Production salon, migration, payment provider, SMS, or call was touched.

## Observed result

- The receptionist UI created exactly one synthetic booking under the QA salon. Booking-notification SMS and email were both deselected. A disabled-card-retry rehearsal first failed closed with zero email receipts.
- After the narrow one-booking QA gate was enabled, one UI click produced one durable `booking_card_retry_email_receipts` row in state `accepted`, with one provider message ID. Resend's matching API log returned HTTP 200, its dedicated QA Sending-only key recorded one use, and the email detail showed **Sent** and **Delivered**. This proves provider acceptance and provider-reported delivery, **not** human inbox reading or card-link completion.
- The receipt ID was `74e82bb5-2edc-4093-8b5a-22ad35825f23` and the provider message ID was `01a0eb54-61ec-736e-8750-69014a4136b8`. The QA receipt count was one. No recipient address, phone, token, or key is recorded here.
- The emailed card-management capability was revoked on QA before expiry. The card link was not opened; Square/Stripe and any charge remained disabled.
- The ordinary PR Preview URL's writes were denied by an existing project-wide WAF rule. A pre-existing QA alias that allowed this path was temporarily assigned to this Preview for the authorized UI test, then restored to its original deployment. No WAF rule was changed.
- The branch-scoped email gate was returned to `0`. The exact booking pin, recipient pin, Sending-only credential, and sender override were removed from the branch environment. The app/site URL overrides were returned to `https://preview-qa.invalid`. A new Preview deployment `dpl_BvGRDSwW1QLbze4sXXD6QjJVvnsQ` reached READY with the disabled configuration; this is **not** Production.

## Limits and residual gates

- The database receipt remains `accepted`; the provider dashboard says `Delivered`. Provider delivery is not the same as an inbox-view confirmation, and the QA Resend webhook did not update the receipt to a delivered state during this check.
- The emailed management link is deliberately not a full card-save test. The temporary QA alias has been returned to its original deployment, and the token was revoked. A separate, payment-safe capability/link end-to-end gate remains required.
- A prior mobile WebKit CI attempt had a booking-success timeout/page crash (19/20); a later run passed 20/20, but a green retry does not establish the original crash's cause. Keep the first failure in the release evidence.
- PR #1429 remains Draft. This rehearsal alone does not authorize a merge, Production migration/deploy, or enabling any live salon.

## Separate payment-safe card-link UI gate — 2026-09-29 UTC

- Used the current PR Preview `dpl_A8kVmM9ZpGwv7xnPe8t7LJqhppme` at head `90ec3cf771068ffc81091340efdea83ddf199caa`, not Production. Vercel's branch-scoped `NAILIQ_CARD_SAVE_DISPATCH_DISABLED` value was visibly `true` before opening the link. The Supabase target was the disposable QA project `uhpzafoiifupyypkcwln`.
- Created one new synthetic salon, service, staff, and future confirmed booking with no real customer contact. Minted one 20-minute `card_manage` capability through the QA RPC. Opening the link in the browser showed the correct synthetic salon/service/time and **Appointment reserved — Card saving is temporarily paused; card protection is not active**. Reload preserved the same truth; no card-entry form or save button appeared.
- Database read-back found the booking still `confirmed`, card required, no saved card or consent, and **zero** `booking_card_save_operations`. The exact capability was revoked with the allowed `manual_revoke` reason. Reload then showed the expired-link message and no appointment metadata. A first attempted QA-only revoke with an unsupported reason was rejected by the database constraint without changing the row; the supported reason succeeded.
- Deleted only the exact synthetic salon after an identity and one-booking count guard. Post-cleanup counts for that salon's service, staff, booking, capability, and card-save operation were all zero. No email, SMS, call, Square, Stripe, charge, or Production mutation occurred in this gate.
- This **passes the hosted link/read/reload/revocation safety path**, not a card-entry, provider-tokenization, or saved-card outcome test. Those remain outside this provider-OFF QA gate.

## Historical WebKit failure disposition

- Original GitHub run `36188450412` failed **1 of 10** mobile WebKit booking submissions: the Success element timed out after the booking RPC had committed; the diagnostic trace also recorded a page crash. The failure is retained, not reclassified as PASS.
- Combined-head run `36455072511` also failed **1 of 20** on attempt 1; attempt 2 passed **20 of 20** on unchanged code. That retry is a reliability observation, not a fix. The attempt-1 trace recorded HTTP 200 responses for the booking RPC, card capability, and optional Wix create, but did not prove the durable booking outcome or identify why Success did not render.
- The combined head carries the post-commit boundary fix from PR #1434: request-ID cleanup and optional Try-On attachment are no longer awaited before Success. It also adds an adversarial held-Web-Lock regression. On current-head GitHub run `36521101474`, non-RC job `109254011425` logged **20/20** mobile WebKit cases passing (10 ordinary submissions and 10 held-lock cases), retries disabled. This supports the specific stall mitigation; it does **not** prove the original WebKit process crash's underlying cause or guarantee a crash cannot recur.

## Current release boundary

- At head `90ec3cf771068ffc81091340efdea83ddf199caa`, PR #1429 is still **Draft** and mergeable. Its required CI checks are successful, with only expected skipped jobs, and Vercel Preview is READY at the same head. These are Preview/code gates, not Production or pilot proof.
- The narrow hosted QA gate has passed and its synthetic data has been removed. The temporary Resend Sending-only key was removed from the Preview environment but remains present provider-side pending action-time confirmation for permanent revocation. Until that cleanup is verified, this record is **not** a complete secret-closeout.
- No Production migration, merge, deploy, live-salon enablement, payment-provider call, or customer notification is authorized by this document. A full card-save/provider-tokenization path was intentionally not tested while providers were OFF.

## Cleanup record

The two temporary QA aliases were checked after restoration: `nailiq-fee-qa-20260925.vercel.app` points back to `dpl_EeimJDMNV824mdjSgpR4tkxzyxLV`; `nailiq-p0-signup-qa-20260911.vercel.app` points back to `dpl_8QvgdLkjWcscHBqZbf1s7TwnNj7A`. A guarded transaction removed the synthetic salon, booking, client profile, receipt, capabilities, membership, and dummy Square integration; post-delete counts for those exact IDs were zero. The exact synthetic receptionist Auth user was removed through the QA Admin API and verified absent. The pre-existing QA owner Auth user was not removed. The temporary Resend key has been removed from this Preview branch; provider-side revocation is tracked separately.
