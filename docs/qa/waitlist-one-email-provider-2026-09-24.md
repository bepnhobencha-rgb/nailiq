# P1-01 — One real Waitlist QA email

## Scope and result

Explicit approval: one Waitlist email to the user-approved QA recipient, provider receipt checked directly in Resend; automatic hosted callback excluded and remains NOT PROVEN. Temporary Sending-only key for nailiq.ca explicitly approved, then revoked. No Production mutation, SMS, call, payment, or booking.

**PASS: hosted UI → QA durable outbox → Resend Delivered.** This is not full P1-01 acceptance or proof of inbox placement.

## Evidence

- Branch: fix/waitlist-invite-identity-20260924.
- App SHA: e1529dd214113dafcbeb48baa36ce1bac36eb7d5.
- Sending Preview: dpl_6Wd3uDdUCuotwFYFzv8GRB8zyUnK, READY before fixture creation.
- QA project: uhpzafoiifupyypkcwln. Public/internal URL match; disposable marker and QA email-recipient pin verified. SMS/call OFF; payment worker OFF; card dispatch disabled.
- Computer Use logged into a one-use synthetic owner, opened Receptionist Center, clicked Mời ngay exactly once on one synthetic individual Waitlist entry.
- Email outbox: fdd846b6-aa93-44fe-b694-802f94fa56d7, epoch 1, status sent, error null.
- Provider message: 01a0d63a-1bba-776e-9f04-5af465cedf23.
- Resend log: 23cf399e-9264-4048-8376-aae44f36a911.
- Resend dashboard showed Sent and Delivered, Sep 24 18:42 Vancouver.
- Provider tags: waitlist_offer, nailiq_env=qa, expected QA ref, matching outbox claim ID.
- Temporary key usage count: exactly 1.
- SMS outbox: suppressed / channel_disabled, no provider receipt.
- Booking count: 0. No claim link visited; no customer booking submitted.

## Cleanup

- Preview env reset: DISABLE_OUTBOUND_EMAIL=1; temporary RESEND_API_KEY, RESEND_FROM and QA recipient values cleared.
- Resend key 6d0401d3-d7f7-4407-8eca-a088e8e93f02 revoked; key list returned to 14 entries and temporary key absent.
- Synthetic salon/entry/outbox/user deleted with exact ID + slug checks; session revoked; residue checks PASS. Deleted fixture is disposable, not restorable through normal UI. Provider receipt retained separately in Resend and this sanitized report.
- Safety redeploy: dpl_3qJXcULV5n8dGjAdeV12vHz7ZhzB, READY, same app SHA, Preview only; email OFF configuration restored.
- Post-cleanup browser reload redirected to login: PASS.
- Production remained dpl_5Er8jXgSjokEgRo2fp2RPqSfmkEN during cleanup verification.

## Targeted regression check

`./node_modules/.bin/vitest run src/shared/noshow/__tests__/deliverPromotedWaitlistOffer.spec.ts src/shared/security/__tests__/resendCustomerDeliveryTruthBoundary.spec.ts`

Result: 2 files, 28 tests PASS, no retry. Vite config-loader warning is present but did not fail the run. These mocks do not prove the hosted callback.

## Limitations and handling note

- No automatic callback proof, no terminal Delivered assertion inside NailIQ, no inbox proof, no SMS/bounce/complaint/reminder proof.
- UI invitation displayed a synthetic date without a specific offered time in the email. This run certifies delivery, not matching accuracy or the customer claim flow.
- The temporary secret unexpectedly appeared in a residual browser accessibility response during modal dismissal. It was not committed or stored in a local file; the exact temporary key was revoked after its single approved send. No Production credential was involved. Future secret-modal dismissal must keep output suppressed until the modal is fully gone.
- No commit, push, migration, or Production deploy in this run.
