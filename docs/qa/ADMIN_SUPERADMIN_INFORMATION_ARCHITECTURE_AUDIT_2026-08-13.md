# Admin + SuperAdmin information architecture audit

Last inspected: 2026-08-13  
Code baseline: `origin/main` at `5a76a59a`  
Scope: every current salon Dashboard page, SuperAdmin shell page, and SuperAdmin authentication page  
Production changes: none

## How to read this audit

The status describes evidence, not confidence or intent:

- **VERIFIED WORKING** — a current automated browser journey proves the route's primary user job, in addition to code and access checks.
- **NEEDS SETUP** — the page works only after salon/vendor/operator configuration, or a high-risk control needs a stronger safety gate.
- **BETA** — feature-flagged or optional capability; it must not be presented as core or block onboarding.
- **BROKEN** — a current contradiction or misleading state is visible in source/evidence.
- **DUPLICATE** — a route is only a legacy redirect or exposes the same job in a second place.
- **UNUSED** — the route exists, but no current product navigation caller was found.
- **UNKNOWN** — code exists, but current runtime proof of the primary job is insufficient.

`HTTP 200`, a React component, a green build, or a label saying “Live” is not enough to earn **VERIFIED WORKING**.

## Executive finding

The system does not mainly suffer from duplicate implementation. It suffers from **too many equally prominent destinations** and **status labels that are stronger than the evidence**.

The safe target is:

1. Do not delete routes or data.
2. Keep five predictable owner/admin jobs visible: **Home**, **Today**, **Customers**, **Business**, **More**.
3. Put salon configuration behind **More → Salon setup** and advanced/flagged tools behind **More → Advanced**.
4. Keep receptionist navigation limited to live desk work.
5. Keep platform operations separate from salon operations in SuperAdmin.
6. Replace manually written “Live” labels with evidence-backed readiness states before claiming operational readiness.

## Recommended top-level structure

### Salon Owner/Admin

| Destination | Owner job | Contains | Decision |
| --- | --- | --- | --- |
| Home | Know what needs attention | owner summary, next action, setup/readiness warning | **KEEP** |
| Today | Run the salon now | calendar, appointments, walk-ins, online Waitlist, groups | **MERGE** live operations into one cockpit |
| Customers | Find and understand a customer | directory, identity review, visit history | **KEEP** |
| Business | Understand results and growth | Pulse, reports, reviews, marketing, loyalty | **MOVE** occasional tools here |
| More | Configure or troubleshoot | salon setup, policies, integrations, AI, activity, account | **MOVE** configuration here |

### SuperAdmin

| Destination | Platform job | Contains | Decision |
| --- | --- | --- | --- |
| Control Tower | See platform exceptions | truthful health/readiness, not a stale roadmap | **FIX** |
| Salons | Support a tenant | salon list, detail, feature state, impersonation | **KEEP** |
| Operations | Operate releases and platform controls | flags, announcements, release review, system health | **KEEP** |
| Support | Investigate incidents | audit logs first; add a hub only when there is a second support tool | **MERGE** redirect into direct nav for now |
| AI Ops | Verify agent reliability and cost | certification matrix, cost ledger | **KEEP**, evidence labels required |
| Admin menu | Rare/high-risk administration | users, MFA/security, platform credentials | **MOVE** out of the everyday rail |

## Salon Dashboard route inventory (34 routes)

| Route | Primary job | Current status | Current evidence / gap | Decision |
| --- | --- | --- | --- | --- |
| `/dashboard/[slug]` | Owner home / next action | **VERIFIED WORKING** | Dashboard E2E covers authenticated owner settings/setup entry; Guided prototype separately proves post-setup Action Center | **KEEP** |
| `/dashboard/[slug]/center` | Today, calendar, walk-ins, groups, Waitlist | **VERIFIED WORKING** | Dedicated receptionist-center desktop/mobile E2E suites; current Waitlist reliability PR adds full QA journey | **KEEP** as one cockpit |
| `/dashboard/[slug]/clients` | Customer directory and identity | **VERIFIED WORKING** | `clients-directory.spec.ts` and `client-identity-merge.spec.ts` | **KEEP** |
| `/dashboard/[slug]/activity` | Owner audit/activity feed | **VERIFIED WORKING** | AI activation E2E reaches and checks the activity surface | **MOVE** to More → System |
| `/dashboard/[slug]/settings` | Configuration hub | **VERIFIED WORKING** | Dashboard and AI activation E2E cover sections and persistence | **KEEP** as More → Salon setup |
| `/dashboard/[slug]/settings/readiness` | Go-live readiness and owner approval | **VERIFIED WORKING** | `go-live-readiness.spec.ts` covers incomplete/ready snapshots | **KEEP**; reuse in Guided Setup |
| `/dashboard/[slug]/setup/services` | Services, duration, price | **VERIFIED WORKING** | Dashboard, setup-prefill, service-delete and empty-salon E2E | **KEEP** |
| `/dashboard/[slug]/setup/staff` | Staff, permissions, offboarding | **VERIFIED WORKING** | staff delete/deactivate E2E plus setup journeys | **KEEP** |
| `/dashboard/[slug]/setup/hours` | Business hours and closed days | **VERIFIED WORKING** | Guided QA E2E proves validation and persistence | **KEEP** |
| `/dashboard/[slug]/setup/address` | Salon identity, address, timezone | **VERIFIED WORKING** | Visual and Guided QA E2E cover route and persistence | **KEEP** |
| `/dashboard/[slug]/setup/ai-prefill` | Import draft setup from AI | **VERIFIED WORKING** | `setup-ai-prefill.spec.ts` covers draft-to-services path | **MOVE** into optional onboarding helper |
| `/dashboard/[slug]/no-show-protection` | Cancellation/no-show rules and charges | **NEEDS SETUP** | Code and safety audit exist; provider credentials, consent and charge readiness vary per tenant | **KEEP** under Policies; never imply charging is active from page presence |
| `/dashboard/[slug]/pulse` | Owner remote snapshot | **UNKNOWN** | Real loader/component exists; no current primary browser certification found | **MOVE** into Business, then certify |
| `/dashboard/[slug]/insights` | Reports and revenue | **BETA** | Flagged `advanced_reports`; identity/report E2E exists but feature is default-off | **MOVE** into Business |
| `/dashboard/[slug]/reviews` | Review operations | **BETA** | Platform/plan gated; no current end-to-end owner journey found | **MOVE** into Business |
| `/dashboard/[slug]/marketing` | Campaigns and schedules | **BETA** | Release-flagged and outbound-sensitive | **MOVE** into Business; show outbound readiness explicitly |
| `/dashboard/[slug]/setup/loyalty` | Loyalty and gift cards | **BETA** | Feature/plan gated; route gating E2E exists, business journey not certified | **MOVE** into Business |
| `/dashboard/[slug]/photos` | Gallery management | **BETA** | Platform/plan gated; static security boundary exists, runtime journey missing | **MOVE** into Brand / My Page |
| `/dashboard/[slug]/combos` | Service packages | **BETA** | Feature default-off with route boundary tests | **MOVE** into Services |
| `/dashboard/[slug]/disputes` | Payment disputes | **NEEDS SETUP** | Financial provider data required; no current safe browser certification found | **MOVE** into Payments |
| `/dashboard/[slug]/ai` | Salon AI Control Center | **BETA** | Explicit feature gate; broader Agent Certification work remains incomplete | **MOVE** into More → AI |
| `/dashboard/[slug]/approvals` | Human approval queue | **BETA** | Role gated and linked from AI; runtime matrix still incomplete | **MERGE** into AI Control Center |
| `/dashboard/[slug]/manager` | AI Manager history | **BETA** | Role gated; exists as a separate history page | **MERGE** into AI Control Center |
| `/dashboard/[slug]/setup/manager-briefing` | AI Manager instructions | **BETA** | Tenant row/feature required; no current full owner journey | **MERGE** into AI setup |
| `/dashboard/[slug]/setup/voice` | AI Receptionist setup | **BETA** | Feature-gated route E2E; live phone/provider proof is tenant-specific | **MOVE** into Integrations → AI Receptionist |
| `/dashboard/[slug]/setup/nail-tryon` | Try-on catalogue | **BETA** | Feature gate exists; public Try-on has separate certification work | **MOVE** into Brand / Growth |
| `/dashboard/[slug]/settings/my-page` | Public booking/site editor | **UNKNOWN** | Access boundary exists; full save/preview/publish browser journey not found | **KEEP**, then certify |
| `/dashboard/[slug]/import` | Website/data import | **NEEDS SETUP** | Owner/admin only and external source dependent | **MOVE** into optional onboarding/import |
| `/dashboard/[slug]/setup/promotions` | Promotion setup | **UNKNOWN** | Linked from Settings; no current browser journey found | **MOVE** into Business → Marketing |
| `/dashboard/[slug]/qr-poster` | Download booking QR poster | **UNKNOWN** | Real page and owner link exist; download artifact not certified | **MOVE** into My Page → Share |
| `/dashboard/[slug]/sessions` | Active salon sessions | **UNKNOWN** | Account-menu reachable; no current browser journey found | **MOVE** into Account → Security |
| `/dashboard/[slug]/referrals` | Referral program | **UNUSED** | Page exists; no current product navigation caller found | **HIDE** until product owner defines placement and validates flow |
| `/dashboard/[slug]/settings/staff` | Legacy staff URL | **DUPLICATE** | Redirects to canonical `/setup/staff` | **MERGE**; keep redirect for old links |
| `/dashboard/[slug]/setup` | Setup entry | **DUPLICATE** on current main | Redirects directly to Services; Guided Setup PR replaces it with the single orchestrator | **FIX** via approved Guided Setup rollout |

## SuperAdmin shell inventory (17 routes)

| Route | Primary job | Current status | Current evidence / gap | Decision |
| --- | --- | --- | --- | --- |
| `/superadmin` | Entry | **DUPLICATE** | Redirect-only route to dashboard | **MERGE**; keep redirect |
| `/superadmin/dashboard` | Platform overview | **BROKEN** | Counters are real, but the visible roadmap says already-delivered phases are still future work | **FIX** copy; replace roadmap with exception/readiness summary |
| `/superadmin/salons` | Tenant list | **VERIFIED WORKING** | Required smoke reaches the route; salon release-feature E2E uses the list/detail area | **KEEP** |
| `/superadmin/salons/[salonId]` | Tenant detail and scoped controls | **VERIFIED WORKING** | `salon-release-features.spec.ts` covers tenant-scoped changes | **KEEP** |
| `/superadmin/users` | Platform accounts | **UNKNOWN** | Loader/table exist; no primary browser certification found | **MOVE** into rare Admin menu, then certify |
| `/superadmin/operations` | Operator tool directory | **UNKNOWN** | Directory renders three tools but hard-codes “Live” without runtime evidence | **FIX** labels; **KEEP** hub |
| `/superadmin/operations/feature-flags` | Platform kill switches | **VERIFIED WORKING** | `feature-flag-toggle.spec.ts` covers toggle and audit trail | **KEEP** with confirmation/audit |
| `/superadmin/operations/announcements` | Platform notices | **UNKNOWN** | Real editor exists; publish/schedule/recipient browser journey not currently certified | **KEEP**, certify before sending real notices |
| `/superadmin/operations/system-health` | Error monitoring | **UNKNOWN** | Real monitor exists; no current incident-to-resolution browser proof found | **KEEP**, certify read-only incident journey |
| `/superadmin/operations/release-reviews/[reviewId]` | Approve/reject owner notice | **NEEDS SETUP** | Signed email/review flow has unit boundaries; real email must remain approval-gated | **KEEP** |
| `/superadmin/support` | Support entry | **DUPLICATE** | Redirects to audit logs because only one live support tool exists | **MERGE** nav directly to Audit logs until a second tool exists |
| `/superadmin/support/audit-logs` | Search platform audit trail | **VERIFIED WORKING** | `audit-logs.spec.ts` covers route and support redirect | **KEEP** |
| `/superadmin/ai` | AI Ops directory | **UNKNOWN** | Two tool cards exist; no current hub browser certification | **KEEP**, evidence-aware labels |
| `/superadmin/ai/costs` | AI cost ledger | **UNKNOWN** | Code exists; cost completeness and conversion linkage remain separate checklist work | **KEEP**, never call complete without provider usage reconciliation |
| `/superadmin/ai/performance` | Agent Certification Matrix | **UNKNOWN** | Code exists; runtime evidence for every agent is incomplete | **KEEP**; this is the authoritative matrix |
| `/superadmin/security` | SuperAdmin MFA | **NEEDS SETUP** | Real MFA manager exists; enrol/recovery/admin-lockout journey not certified here | **MOVE** into rare Admin menu and certify |
| `/superadmin/settings` | Platform credentials | **NEEDS SETUP** | Page states changes take effect immediately without redeploy; this is a high-risk secret/credential control | **FIX** with typed confirmation, audit, validation/test, and rollback evidence; **MOVE** into Admin menu |

## SuperAdmin authentication inventory (4 routes)

| Route | Primary job | Current status | Gap | Decision |
| --- | --- | --- | --- | --- |
| `/superadmin/login` | Sign in | **VERIFIED WORKING** | Shared SuperAdmin E2E helper authenticates through this boundary | **KEEP** |
| `/superadmin/mfa` | MFA challenge | **NEEDS SETUP** | Challenge UI exists; full enrol/challenge/recovery journey needs certification | **KEEP** |
| `/superadmin/forgot-password` | Request reset | **UNKNOWN** | Code exists; delivery and anti-enumeration journey not certified | **KEEP**, certify safely |
| `/superadmin/reset-password` | Complete reset | **UNKNOWN** | Code exists; signed-link expiry/reuse journey not certified | **KEEP**, certify safely |

## Confirmed duplicates and unused surfaces

Only three route-level duplicates were found:

1. `/dashboard/[slug]/settings/staff` → canonical `/setup/staff`.
2. `/dashboard/[slug]/setup` → currently redirects to Services; the Guided Setup prototype correctly turns this into the orchestrator.
3. `/superadmin/support` → redirects to audit logs because there is only one support tool.

One route currently has no product navigation caller:

- `/dashboard/[slug]/referrals`.

These should remain backward-compatible routes. “MERGE” means one canonical UI destination, not deleting URLs or records.

## P0/P1 actions before broad rollout

| Priority | Action | Why | Safe next proof |
| --- | --- | --- | --- |
| P0 | Finish Guided Setup and hide unrelated first-run menus only for the QA flag | New owners otherwise face the full product map before setup | QA-only browser prototype; Hi-Lite flags remain off |
| P0 | Remove stale SuperAdmin roadmap claims | Current copy contradicts delivered routes and weakens trust | Copy-only test + screenshot |
| P0 | Harden Platform Settings credentials | Immediate credential changes can break all salons | Unit boundary + QA validation; no production secret change |
| P0 | Stop hard-coded “Live” labels without runtime proof | A card label is not readiness evidence | Derive states from checks or use neutral “Open tool” |
| P1 | Add route-level certification for UNKNOWN core surfaces | Prevent “looks present” from becoming “works” | QA E2E per primary job |
| P1 | Move optional/BETA tools out of the everyday rail | Reduces clutter without deleting capability | Flagged prototype + before/after screenshots |
| P1 | Use one AI Control Center and one AI certification matrix | Avoid three separate owner mental models | Deep links to one canonical hub |

## Rollout boundary

No navigation move or hide should ship broadly from this audit alone. The implementation order is:

1. approve the information architecture prototype;
2. enable it only for the disposable QA salon;
3. verify role, desktop, tablet and mobile access;
4. ensure every hidden item remains reachable from its new canonical hub;
5. compare support/task completion before and after;
6. roll out gradually behind a feature flag;
7. keep Hi-Lite Head Spa and Hi-Lite Studio unchanged until explicit approval.

