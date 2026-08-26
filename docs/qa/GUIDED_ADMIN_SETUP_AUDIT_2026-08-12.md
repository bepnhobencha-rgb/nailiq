# Guided Admin Setup — QA-only audit

Last verified locally: 2026-08-20
Scope: `guided_admin_setup_enabled` prototype only
Production salons protected: no flag or data write was made to Hi-Lite Head Spa or Hi-Lite Studio

## Resume checkpoint — 2026-08-20 22:18 America/Vancouver

- **PASS_LOCAL:** current-tree Guided matrix passed 14 files / 116 tests / 0 failures after replacing one whitespace-sensitive source assertion with an equivalent structural regex.
- **PASS_LOCAL:** `npm run typecheck`, scoped Guided ESLint, and `npm run build` passed; Next.js generated 57/57 static pages. The build emitted only the existing Edge Runtime deprecation/static-generation warnings.
- **NOT_PROVEN / BLOCKED_ENV:** `e2e/guided-admin-setup.spec.ts` was not run. This worktree has no `.env.local` or `.env.test.local`, no Supabase CLI, and no Docker runtime, so there is no evidenced isolated disposable database. The Playwright production guard remains intact; no hosted project, provider, production salon, SMS, email, call, booking, payment, flag, deployment, or migration was touched.
- **E2E readiness:** the spec now covers real registration, the 14-day trial interval, no payment identifiers/provider, QA-only pilot opt-in after disposable salon creation, data-derived 25% → 38% progress, persisted resume after sign-in, Owner/Admin versus receptionist access, legacy flag-off behavior, Safe Preview side-effect counts, stale-proof invalidation, and completed handoff. Execution still requires an approved isolated test runtime.

**Evidence boundary:** every VERIFIED WORKING label below means local code/logic
evidence only. PR #1235 previously ran the disposable authenticated journey with
147 tests passing, 2 skipped and 1 stale progress assertion failing (expected
50%, data-derived result 38%). The current Safe Preview/readiness candidate has
not run in disposable Supabase/browser E2E, so route-level runtime certification
remains **NEEDS SETUP**.

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
| Final readiness | Separate Settings destination | Reused as steps 8–9; no second approval system; rehearsal and Owner approval require a current strict Safe Preview proof | **MERGE** |
| Step completion | 5 broad items | 8 required steps plus 1 optional integration step, derived from readiness and attestations | **FIX** |

## Route inventory

| Route | Owner job | Status | Evidence / remaining work | Decision |
| --- | --- | --- | --- | --- |
| `/dashboard/[slug]/setup` | Resume the single next action | **NEEDS SETUP** | Local logic proves data-derived sequencing and exactly one forward action; authenticated runtime/E2E is unavailable | **KEEP** |
| `/dashboard/[slug]/setup/address` | Salon identity, contact, timezone | **NEEDS SETUP** | Local validation, salon-name editor and Guided autosave pass compile/type gates; runtime persistence is unverified | **KEEP** |
| `/dashboard/[slug]/setup/hours` | Hours and closed days | **NEEDS SETUP** | Local client/server logic rejects fully closed or open-at/after-close schedules and impossible dates; runtime persistence is unverified | **KEEP** |
| `/dashboard/[slug]/setup/staff` | Staff, job role, dashboard access | **NEEDS SETUP** | The prior public Server Function PII/tenant gap is closed locally with same-salon Owner/Admin authorization. Linked-login dashboard-access runtime proof remains unavailable | **FIX** remaining runtime proof |
| `/dashboard/[slug]/setup/services` | Services, price, duration, capability | **NEEDS SETUP** | Local readiness requires each non-deleted, non-add-on service to have valid price/duration and an explicit active staff assignment; runtime is unverified | **KEEP** |
| `/dashboard/[slug]/no-show-protection` | Cancel/no-show/group/after-hours policy | **NEEDS SETUP** | Guided mode now returns an Owner/Admin-only policy surface before importing operational no-show/provider controls. It writes only the allowlisted policy fields; browser/runtime proof is pending | **MERGE** into step 5 |
| `/dashboard/[slug]/settings?section=notifications` | Language, fallback, OTP/consent | **NEEDS SETUP** | Verified email and EN/VI locale block readiness. SMS defaults and route/action enforcement remain rollout blockers | **MERGE** into step 6, then **FIX** consent/auth boundaries |
| `/dashboard/[slug]/settings?section=integrations` | Payment and AI choices | **BETA** | Optional and excluded from required percentage; selecting a provider remains REVIEW without runtime credential proof | **MOVE** to optional step 7 |
| `/dashboard/[slug]/setup/preview` | Safe booking preview | **NEEDS SETUP** | Local source/gates PASS for the narrow individual, base-service, non-resource path. It reuses public catalog data, strictly rechecks service/staff/date/time, disables booking submission and fails closed for resource, add-on, combo, promotion and group surfaces. Disposable browser proof is pending | **FIX** runtime proof, then **KEEP** |
| `/dashboard/[slug]/settings/readiness` | Rehearsal and owner approval | **NEEDS SETUP** | Prerequisites bind the technical snapshot; Owner approval binds the approval snapshot and replays the exact server-recorded preview selection. Catalog, tax, lead/buffer, shifts and unsupported surfaces stale prior proof. Disposable runtime proof is pending | **MERGE** into steps 8–9 |
| `/dashboard/[slug]` | Post-setup Admin Action Center | **NEEDS SETUP** | Implementation and local handoff tests pass; the full completed journey remains unavailable until current disposable E2E passes | **KEEP** behind the QA flag |

## Card and action inventory

| UI item | Status | Evidence / remaining work | Decision |
| --- | --- | --- | --- |
| Progress percentage | **VERIFIED WORKING** | Counts 8 required data-backed steps; optional integration excluded | **KEEP** |
| One “Continue setup” action | **VERIFIED WORKING** | Always selects first incomplete required step | **KEEP** |
| Reason and validation copy | **VERIFIED WORKING** | English/Vietnamese copy per step | **KEEP** |
| Step overview and route deep-links | **VERIFIED WORKING** | The overview is inert and the primary CTA is the only forward control; canonical authenticated route URLs remain stable for resume | **KEEP** |
| Optional integration label | **VERIFIED WORKING** | Explicitly says skipped for now; selected-but-unverified remains REVIEW and never blocks core setup | **KEEP** |
| Resume after login | **NEEDS SETUP** | Historical disposable E2E proved new trial registration and resume; the current candidate corrects the 38% data-derived expectation and fail-closed persistence. Current combined SHA still needs disposable rerun | **KEEP**, then verify current candidate |
| Safe persistence and deliberate confirmation | **VERIFIED WORKING** | Low-risk profile/hours fields auto-save only in Guided mode. Staff, services, policy, notification and readiness actions keep explicit Save/approval because they change access, prices, consent or go-live state | **KEEP** this safety boundary |
| Back / Continue inside every setup screen | **VERIFIED WORKING** | Canonical Guided destinations expose explicit Back and Continue; Continue returns to data-derived orchestration | **KEEP** |
| Hide unrelated first-run menus | **VERIFIED WORKING** | Incomplete setup and the first completed root Action Center use focused shell mode; nested operational routes restore normal navigation | **HIDE** only inside the QA-flagged experience |

## Explicit rollout exposure inventory

| Exposure | Status | Evidence / risk | Decision |
| --- | --- | --- | --- |
| Step 5 live financial/provider actions | **VERIFIED WORKING** locally | Guided mode returns the narrow policy component before loading the legacy operational hub, Square sync or provider actions. Guided policy writes are allowlisted and Owner/Admin-only; the flag-off legacy surface remains unchanged | **HIDE** from Guided; **KEEP** legacy surface |
| Unsupported booking surfaces | **NEEDS SETUP** | Resource, add-on, combo, active promotion and group-booking salons fail closed because the current Safe Preview certifies only individual base-service availability | **KEEP** fail-closed until each surface has separate proof |
| Direct future-route access | **NEEDS SETUP** | The overview is inert, but authenticated users can still enter later canonical routes directly; this prototype has no server route-sequence guard | **FIX** only with approved route/action criteria |
| Vietnamese coverage | **NEEDS SETUP** | Core orchestrator copy is bilingual, but reused settings/policy/provider surfaces still contain incomplete Vietnamese copy | **FIX** before bilingual acceptance |
| Trial and announcement actions | **NEEDS SETUP** | Existing shell/page trial prompts and announcement actions may add interactive choices beyond the intended single next setup action | **MOVE** or **HIDE** inside the QA-focused shell after product review |

## Safety conclusions

1. The feature remains default-off and stored in the existing salon feature flags.
2. The branch adds narrowly scoped authorization/RLS/rollout migrations and appends Go-Live attestation audit events. Safe Preview itself creates no booking, waitlist entry, OTP, card/payment state, message, call, AI action or provider request.
3. Completion is not inferred from clicks. Technical configuration plus current prerequisite attestations determine progress. Rehearsal and Owner approval require a server-rechecked available slot; any material catalog/tax/availability change makes old proof stale. Unsupported public booking surfaces remain fail-closed.
4. Current local gates PASS: focused Safe Preview/readiness 118/118; full unit 280 files passed plus 1 skipped, 1560 tests passed plus 1 skipped; typecheck; full lint with 0 errors and 56 pre-existing warnings; production build compiled and generated 61/61 static pages. Disposable authenticated browser E2E remains **NOT PROVEN** because this worktree has no local Supabase CLI, Docker runtime or test credentials.
5. Remaining rollout blockers: current disposable E2E and CI/preview deployment; linked-staff runtime proof; notification/SMS consent and action authorization; direct future-route product criteria; incomplete Vietnamese coverage; trial/announcement extra actions; and separate certification for resource/add-on/combo/promotion/group booking surfaces.
6. The feature must remain default-off. Actual salon IDs/flags for Hi-Lite Head Spa and Hi-Lite Studio were not read or changed in this local-only audit, so tenant-specific negative proof remains unavailable.
