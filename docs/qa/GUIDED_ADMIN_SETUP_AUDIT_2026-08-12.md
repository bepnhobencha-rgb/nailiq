# Guided Admin Setup — QA-only audit

Last verified: 2026-08-13
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
| `/dashboard/[slug]/setup` | Resume the single next action | **VERIFIED WORKING** | Data-backed progression plus authenticated registration/resume E2E on a throwaway database | **KEEP** |
| `/dashboard/[slug]/setup/address` | Salon identity, contact, timezone | **VERIFIED WORKING** | Validation, Guided-only debounced auto-save, manual fallback, persistence E2E | **KEEP** |
| `/dashboard/[slug]/setup/hours` | Hours and closed days | **VERIFIED WORKING** | Validation, Guided-only debounced auto-save, manual fallback, persistence E2E | **KEEP** |
| `/dashboard/[slug]/setup/staff` | Staff, job role, dashboard access | **VERIFIED WORKING** | Existing staff/access controls plus edit/reload persistence E2E | **KEEP** |
| `/dashboard/[slug]/setup/services` | Services, price, duration | **VERIFIED WORKING** | Existing service validation plus edit/reload persistence E2E | **KEEP** |
| `/dashboard/[slug]/no-show-protection` | Cancel/no-show policy and optional protection | **VERIFIED WORKING** | E2E proves bilingual policy, group coverage and after-hours ownership; policy changes remain deliberate Save actions | **MERGE** into step 5 |
| `/dashboard/[slug]/settings?section=notifications` | Language, fallback, OTP/consent | **VERIFIED WORKING** | E2E proves verified email surface and bilingual notification preference persistence | **MERGE** into step 6 |
| `/dashboard/[slug]/settings?section=integrations` | Payment and AI choices | **BETA** | Optional and excluded from required percentage | **MOVE** to optional step 7 |
| `/dashboard/[slug]/settings/readiness` | Preview, rehearsal, owner approval | **VERIFIED WORKING** | Snapshot-bound attestations plus E2E proof that 100% and Action Center require Owner approval | **MERGE** into steps 8–9 |
| `/dashboard/[slug]` | Post-setup Admin Action Center | **VERIFIED WORKING** | Guided-only Action Center appears after current readiness snapshot is approved | **KEEP** |

## Card and action inventory

| UI item | Status | Evidence / remaining work | Decision |
| --- | --- | --- | --- |
| Progress percentage | **VERIFIED WORKING** | Counts 8 required data-backed steps; optional integration excluded | **KEEP** |
| One “Continue setup” action | **VERIFIED WORKING** | Always selects first incomplete required step | **KEEP** |
| Reason and validation copy | **VERIFIED WORKING** | English/Vietnamese copy per step | **KEEP** |
| Step list deep-links | **VERIFIED WORKING** | Every step links to the existing canonical route | **KEEP** |
| Optional integration label | **VERIFIED WORKING** | Clearly says it can be done later and never blocks completion | **KEEP** |
| Resume after login | **VERIFIED WORKING** | Registration creates a 14-day trial without payment setup; cookie clear and sign-in resume the same data-derived next step | **KEEP** |
| Safe persistence and deliberate confirmation | **VERIFIED WORKING** | Low-risk profile/hours fields auto-save only in Guided mode. Staff, services, policy, notification and readiness actions keep explicit Save/approval because they change access, prices, consent or go-live state | **KEEP** this safety boundary |
| Back / Continue inside every setup screen | **VERIFIED WORKING** | Every canonical destination exposes the Guided return card; Preview continues to existing Readiness | **KEEP** |
| Hide unrelated first-run menus | **NEEDS SETUP** | Guided page is focused, but dashboard layout/deep links are not yet fully gated | **HIDE** only after prototype approval |

## Safety conclusions

1. The feature remains default-off and stored in the existing salon feature flags.
2. No new progress table, migration, booking, message, call, campaign, or payment action is introduced.
3. Completion is not inferred from clicks. Required steps must pass their current readiness checks and the Owner must approve the current snapshot.
4. Authenticated browser E2E now proves registration handoff, resume, validation, persistence, back/continue and final Action Center behavior on a throwaway database.
5. The remaining rollout gate is explicit QA-salon approval plus a clean PR; the feature must stay flag-off for Hi-Lite Head Spa and Hi-Lite Studio.
