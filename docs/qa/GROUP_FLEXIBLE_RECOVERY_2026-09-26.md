# Group flexible recovery — local acceptance, 2026-09-26

## Scope and release boundary

Branch `feat/group-flexible-recovery-20260925`, base `278bd63302bfa91d670f35fe0616f4fe04b6a92b`.
Implements the approved first phase: invite a replacement, truthful cancellation-fee disclosure, authoritative member status. No waitlist automation, automatic fee waiver/refund, notification delivery, or production activation.

## Before this change

- A party contact claim was displayed as attendance confirmation, without checking cancellation or attendance state.
- The public cancellation screen said “Cancel & pay” and promised automatic refill refunds even though the endpoint only created an Owner/Admin fee review.
- Individual group cancellation has no authority to charge the organizer; the whole-party agreement does not establish member-specific liability.

## Implemented locally

- Member-own private cancellation capability can create an expiring, one-use replacement link. Shared party URLs cannot grant replacement authority.
- Existing slot remains reserved until a single atomic acceptance cancels the original and creates a fresh identity at the same service/staff/resource/time/price.
- Only hashes of invitation capabilities are stored. Same-request replay returns the committed result; changed payloads cannot replace it. Group locking serializes acceptance, cancellation and revocation.
- No card, customer profile, payment token, consent, contact identity or private management token is transferred. No provider call or outbound send is part of replacement.
- Invite creation is not completion or fee exemption. The cancellation page explains possible fees require Owner/Admin review and cancellation itself does not charge the card. Individual group attendance changes explicitly disclose no authorized member fee.
- Public/desk group status uses booking lifecycle and attendance. A replaced slot shows the new participant read-only, and cancelled members do not contribute active counts/revenue.
- Accepted-original exclusion repairs whole-party cancellation/rescheduling without permitting ordinary terminal rows to be changed. Previous shared contact forms cannot rewrite accepted original identity.

## Deliberate first-release limitations

Online replacement is available only for a confirmed, non-organizer, single-service member at a synthetic/approved salon with no required card, deposit, payment/card operation, external provider booking, promotion/add-on/combo, or OTP/deposit verification requirement. A replacement guest cannot replace themselves again in this phase. Other cases require salon assistance.

The replacement has no new private self-management link; later changes require salon help. Existing whole-group capabilities become stale when membership changes; freshly issued group capabilities operate on the replacement roster. No customer message is automatically sent to refresh those links.

**The two card-protected live Hi-Lite salons therefore cannot use automatic replacement under this first-phase eligibility.** A fresh replacement card/consent and verification flow is required before extending eligibility. Never disable an existing salon's protection/verification to make replacement eligible.

## Gates and rollback

- `NAILIQ_GROUP_SLOT_RECOVERY=true` plus salon `feature_flags.group_slot_recovery_v1=true` enable the feature. Both remain absent/OFF outside disposable QA.
- Set `NAILIQ_GROUP_SLOT_RECOVERY_WRITES=false` to stop new mutations while keeping inspection and roster projection available. Preserve the primary/read and salon gates for accepted history.
- Retain the additive schema and successful replacement receipts. Do not resurrect cancelled originals, remove receipts, restore an old schema, or blindly redeploy pre-projection code after accepted replacements exist.
- Before first accepted replacement, code can be rolled back with the feature OFF; retain schema for audit. After acceptance, prefer a forward fix with mutations OFF and read/history retained.
- Migration uses strict anchor assertions when extending existing management functions. Apply must fail atomically if expected function definitions differ; investigate the target schema rather than bypassing assertions.

## Evidence and status

Local unit, SQL, race, browser-fixture and actual computer-use evidence are recorded in `/Users/huytran/nailiq-group-recovery-evidence-20260925/` and local test output. Browser-fixture actions are inert and are separately labeled from actual PostgREST/database computer-use checks.

Huy approved commit, push, PR and QA Preview on 2026-09-26. This report records the local acceptance checkpoint; CI and hosted Preview results will be recorded in the PR. Production migration, activation and deployment are not authorized by this approval. Previous fee collection release evidence is not evidence for this feature.

### Final local acceptance

- 49 focused unit assertions: PASS; 23 existing party helper checks: PASS.
- 30 SQL assertions on disposable schema: PASS; exact migration applied atomically on a clean schema copy and the same suite passed there.
- 20 identical acceptance requests: one mutation and 19 replays; 20 different request IDs: one winner; acceptance versus revoke: one atomic winner.
- 32 inert component-browser cases (Chromium/WebKit mobile, EN/VI): PASS.
- Actual Computer Use against local Next → PostgREST → disposable database: create invite, reload, recover same link, accept, both sides reload, required-card block and group roster verified. One fresh booking; original terminal; same slot/price; no inherited card/consent; zero replacement payment operations or owner notification jobs.
- Typecheck PASS; touched-source lint PASS (two existing warnings); complete Next webpack build PASS. Turbopack initially failed on sandbox internal-port binding; webpack is the verified build path.
- Hosted QA Preview, CI and Production: NOT RUN for this feature. Local PASS is not release/Production proof.
