# Guided Admin Setup — QA-only audit

Last verified locally: 2026-08-15
Scope: `guided_admin_setup_enabled` prototype only  
Production salons protected: no flag or data write was made to Hi-Lite Head Spa or Hi-Lite Studio

## Evidence labels

- **VERIFIED WORKING** — covered by current code plus automated test/typecheck/lint evidence.
- **NEEDS SETUP** — route exists, but the new guided experience still needs product or browser/runtime proof.
- **BETA** — optional capability that must not block core setup.
- **BROKEN** — reproducible defect with evidence.
- **DUPLICATE** — same owner job is exposed in more than one place.
- **UNUSED** — no caller or navigation path found.
- **UNKNOWN** — not enough evidence yet.

## Before / after decision

| Surface | Before | QA prototype after | Decision |
| --- | --- | --- | --- |
| `/dashboard/[slug]/setup` | Redirected immediately to Services | One orchestrator shows one next required action and a 9-step journey | **MERGE** |
| Setup progress | Implied by page visits | Recomputed from salon configuration and Go-Live Readiness | **KEEP** |
| Optional payments / AI | Mixed with required configuration | Explicit optional step excluded from completion percentage | **MOVE** |
| Settings catalogue | Full settings remains available | Guided flow deep-links only to the relevant existing surface | **KEEP**, then **HIDE** from first-run navigation after approval |
| Final readiness | Separate Settings destination | Reused as steps 8–9; no second approval system; QA remains fail-closed until safe preview proof exists | **MERGE**, then **FIX** preview boundary |
| Step completion | 5 broad items | 8 required steps plus 1 optional integration step, derived from readiness and attestations | **FIX** |

## Route inventory

| Route | Owner job | Status | Evidence / remaining work | Decision |
| --- | --- | --- | --- | --- |
| `/dashboard/[slug]/setup` | Resume the single next action | **VERIFIED WORKING** | Pure/unit coverage proves data-derived sequencing and exactly one forward action; authenticated E2E is unavailable in this clean worktree | **KEEP** |
| `/dashboard/[slug]/setup/address` | Salon identity, contact, timezone | **VERIFIED WORKING** | Server validation, salon-name editor, Guided-only debounced auto-save and manual fallback compile and pass unit/type gates | **KEEP** |
| `/dashboard/[slug]/setup/hours` | Hours and closed days | **VERIFIED WORKING** | Server rejects fully closed or open-at/after-close schedules and impossible closed dates; valid seven-days-open salons pass | **KEEP** |
| `/dashboard/[slug]/setup/staff` | Staff, job role, dashboard access | **NEEDS SETUP** | Job roles are data-checked. Linked-login authorization intentionally remains unverified instead of using a service-role helper | **FIX** with an approved auth-safe proof boundary |
| `/dashboard/[slug]/setup/services` | Services, price, duration, capability | **VERIFIED WORKING** | Every active service must have valid price/duration and an explicit active staff assignment for the QA pilot | **KEEP** |
| `/dashboard/[slug]/no-show-protection` | Cancel/no-show/group/after-hours policy | **NEEDS SETUP** | Bilingual policy and enabled group values block readiness. Cross-route/action authorization and after-hours policy criteria still need approval | **MERGE** into step 5, then **FIX** enforcement |
| `/dashboard/[slug]/settings?section=notifications` | Language, fallback, OTP/consent | **NEEDS SETUP** | Verified email and EN/VI locale block readiness. SMS defaults and route/action enforcement remain rollout blockers | **MERGE** into step 6, then **FIX** consent/auth boundaries |
| `/dashboard/[slug]/settings?section=integrations` | Payment and AI choices | **BETA** | Optional and excluded from required percentage; selecting a provider remains REVIEW without runtime credential proof | **MOVE** to optional step 7 |
| `/dashboard/[slug]/setup/preview` | Safe booking preview | **BROKEN** | The normal public booking route can create side effects. The prototype removes that link, shows a server-owned read-only summary and cannot mark rehearsal PASS | **FIX** with an authenticated, non-side-effect preview |
| `/dashboard/[slug]/settings/readiness` | Rehearsal and owner approval | **NEEDS SETUP** | Reuses existing attestations and binds more material data to the owner snapshot, but the Guided pilot is deliberately blocked without safe preview proof | **MERGE** into steps 8–9 |
| `/dashboard/[slug]` | Post-setup Admin Action Center | **NEEDS SETUP** | Implementation exists and pure tests cover the handoff, but it is unreachable by design until the preview blocker is resolved | **KEEP** behind the QA flag |

## Card and action inventory

| UI item | Status | Evidence / remaining work | Decision |
| --- | --- | --- | --- |
| Progress percentage | **VERIFIED WORKING** | Counts 8 required data-backed steps; optional integration excluded | **KEEP** |
| One “Continue setup” action | **VERIFIED WORKING** | Always selects first incomplete required step | **KEEP** |
| Reason and validation copy | **VERIFIED WORKING** | English/Vietnamese copy per step | **KEEP** |
| Step list deep-links | **VERIFIED WORKING** | Only the current next step is interactive; authenticated direct route URLs remain stable for resume | **KEEP** |
| Optional integration label | **VERIFIED WORKING** | Explicitly says skipped for now; selected-but-unverified remains REVIEW and never blocks core setup | **KEEP** |
| Resume after login | **NEEDS SETUP** | Data-derived resume has unit coverage. Current registration needs a test-only post-create flag patch; production handoff is not certified | **FIX** only after auth/product approval |
| Safe persistence and deliberate confirmation | **VERIFIED WORKING** | Low-risk profile/hours fields auto-save only in Guided mode. Staff, services, policy, notification and readiness actions keep explicit Save/approval because they change access, prices, consent or go-live state | **KEEP** this safety boundary |
| Back / Continue inside every setup screen | **VERIFIED WORKING** | Canonical Guided destinations expose explicit Back and Continue; Continue returns to data-derived orchestration | **KEEP** |
| Hide unrelated first-run menus | **VERIFIED WORKING** | Incomplete setup and the first completed root Action Center use focused shell mode; nested operational routes restore normal navigation | **HIDE** only inside the QA-flagged experience |

## Safety conclusions

1. The feature remains default-off and stored in the existing salon feature flags.
2. No new progress table, migration, booking, message, call, campaign, or payment action is introduced.
3. Completion is not inferred from clicks. Required steps must pass current data/readiness checks; the QA pilot remains below 100% even if a rehearsal attestation was recorded because no safe preview proof exists.
4. Local gates pass: focused tests, full unit suite, typecheck, lint and production build. Authenticated browser E2E was not run because this clean worktree has no disposable Supabase test credentials.
5. Rollout blockers include the side-effect-free preview boundary, linked staff authorization proof, platform kill-switch composition, registration authorization, complete snapshot binding, settings/policy authorization enforcement, SMS consent defaults and seeded-data review semantics.
6. The feature must remain default-off. Actual salon IDs/flags for Hi-Lite Head Spa and Hi-Lite Studio were not read or changed in this local-only audit, so tenant-specific negative proof remains unavailable.
