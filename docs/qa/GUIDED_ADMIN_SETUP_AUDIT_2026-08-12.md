# Guided Admin Setup — QA-only audit

Date: 2026-08-12  
Scope: `guided_admin_setup_enabled` prototype only  
Production salons protected: Hi-Lite Head Spa and Hi-Lite Studio remain flag-off

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
| Final readiness | Separate Settings destination | Reused as steps 8–9; no second approval system | **MERGE** |
| Step completion | 5 broad items | 8 required checks plus 1 optional integration step | **FIX** |

## Route inventory

| Route | Owner job | Status | Evidence / remaining work | Decision |
| --- | --- | --- | --- | --- |
| `/dashboard/[slug]/setup` | Resume the single next action | **VERIFIED WORKING** | Pure progression tests, typecheck, lint | **KEEP** |
| `/dashboard/[slug]/setup/address` | Salon identity, contact, timezone | **VERIFIED WORKING** | Existing validation and explicit Save control | **KEEP** |
| `/dashboard/[slug]/setup/hours` | Hours and closed days | **VERIFIED WORKING** | Existing validation, explicit Save, human confirmation still required | **KEEP** |
| `/dashboard/[slug]/setup/staff` | Staff, job role, dashboard access | **VERIFIED WORKING** | Existing staff/access controls; guided browser proof pending | **KEEP** |
| `/dashboard/[slug]/setup/services` | Services, price, duration | **VERIFIED WORKING** | Existing service validation and save actions | **KEEP** |
| `/dashboard/[slug]/no-show-protection` | Cancel/no-show policy and optional protection | **NEEDS SETUP** | Guided check reads bilingual policy; group/after-hours options remain optional unless enabled | **MERGE** into step 5 |
| `/dashboard/[slug]/settings?section=notifications` | Language, fallback, OTP/consent | **NEEDS SETUP** | Data-backed checks exist; end-to-end owner flow pending | **MERGE** into step 6 |
| `/dashboard/[slug]/settings?section=integrations` | Payment and AI choices | **BETA** | Optional and excluded from required percentage | **MOVE** to optional step 7 |
| `/dashboard/[slug]/settings/readiness` | Preview, rehearsal, owner approval | **VERIFIED WORKING** | Existing snapshot-bound attestations and tests; real QA rehearsal still required | **MERGE** into steps 8–9 |
| `/dashboard/[slug]` | Post-setup Admin Action Center | **NEEDS SETUP** | Current full dashboard remains; simplified post-completion Action Center is not implemented | **FIX** after prototype approval |

## Card and action inventory

| UI item | Status | Evidence / remaining work | Decision |
| --- | --- | --- | --- |
| Progress percentage | **VERIFIED WORKING** | Counts 8 required data-backed steps; optional integration excluded | **KEEP** |
| One “Continue setup” action | **VERIFIED WORKING** | Always selects first incomplete required step | **KEEP** |
| Reason and validation copy | **VERIFIED WORKING** | English/Vietnamese copy per step | **KEEP** |
| Step list deep-links | **VERIFIED WORKING** | Every step links to the existing canonical route | **KEEP** |
| Optional integration label | **VERIFIED WORKING** | Clearly says it can be done later and never blocks completion | **KEEP** |
| Resume after login | **NEEDS SETUP** | Server redirect uses current saved data; authenticated browser E2E pending | **FIX** with QA E2E |
| Auto-save on every step | **NEEDS SETUP** | Address and Hours currently use explicit Save; do not claim auto-save | **FIX** only after interaction design approval |
| Back / Continue inside every setup screen | **NEEDS SETUP** | Back links exist; consistent Continue footer does not yet exist on every screen | **FIX** after prototype approval |
| Hide unrelated first-run menus | **NEEDS SETUP** | Guided page is focused, but dashboard layout/deep links are not yet fully gated | **HIDE** only after prototype approval |

## Safety conclusions

1. The feature remains default-off and stored in the existing salon feature flags.
2. No new progress table, migration, booking, message, call, campaign, or payment action is introduced.
3. Completion is not inferred from clicks. Required steps must pass their current readiness checks and the Owner must approve the current snapshot.
4. Do not roll out beyond the QA salon until authenticated browser E2E proves resume, validation, back/continue, and final redirect behavior.
