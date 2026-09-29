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

## Cleanup record

The two temporary QA aliases were checked after restoration: `nailiq-fee-qa-20260925.vercel.app` points back to `dpl_EeimJDMNV824mdjSgpR4tkxzyxLV`; `nailiq-p0-signup-qa-20260911.vercel.app` points back to `dpl_8QvgdLkjWcscHBqZbf1s7TwnNj7A`. A guarded transaction removed the synthetic salon, booking, client profile, receipt, capabilities, membership, and dummy Square integration; post-delete counts for those exact IDs were zero. The exact synthetic receptionist Auth user was removed through the QA Admin API and verified absent. The pre-existing QA owner Auth user was not removed. The temporary Resend key has been removed from this Preview branch; provider-side revocation is tracked separately.
