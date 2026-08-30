# Architectural Decisions

This file logs significant architectural and operational decisions for nailiq.
Newest entries on top.

---

## 2026-08-29 — Group multi-service requires one atomic party-sequence commit

**Status.** Local Phase 2A quote foundation approved by the Product Owner in
chat. Runtime creation and salon rollout remain unavailable until the database
commit path is implemented and verified in QA.

**Decision.** “One guest, many services” and “many guests” remain distinct
canonical engines, but a combined party sequence enters through a dedicated
`canonical_group_sequence` route. Online and Desk may prepare that intent;
Voice fails closed until it has an explicit contract and review flow.

- Every member has one idempotent sequence identity and one or more ordered
  service segments.
- A whole-party proof checks cross-member staff and resource overlap. Separate
  valid member quotes are not sufficient evidence that the group is feasible.
- “Sit together” is never inferred from resource names or simultaneous starts;
  salon-owned adjacency topology must prove it.
- Runtime stays OFF unless group booking, multi-service booking, multi-service
  readiness, and one atomic group-sequence commit boundary are all ready.
- No adapter may create members one-by-one. Partial success would violate the
  canonical receipt and retry guarantees in the Product Constitution.

**Current boundary.** Phase 2A adds the runtime-neutral contract/validator,
route declaration, default-OFF platform and per-salon gates, optional
salon-owned resource adjacency labels, and a service-role-only authoritative
whole-party quote RPC.
The quote reuses the canonical per-member sequence resolver, then rejects
cross-member staff/resource collisions and unproven sit-together claims. A
local disposable Postgres rehearsal proves the RPC returns a whole-party quote
without creating bookings, profiles, or OTP rows. Readiness deliberately
returns `atomic_commit_ready=false` and `ready=false`; there is still no public
or Desk UI, create RPC, notification, payment call, QA/production migration,
feature activation, or production change.

**Phase 2B1 local boundary.** The next additive migration introduces one
service-role-only whole-party create RPC and one read-only replay RPC. The
create path re-quotes and locks the full party, writes every booking, segment,
add-on, profile claim and organizer OTP binding in one transaction, and returns
the committed receipt on an exact retry before fresh availability checks. Guest
identity is never copied from the organizer, and only the organizer booking is
bound to the OTP. Runtime readiness remains false because the existing legacy
group reschedule path changes only parent booking rows and is not safe for
`segments_v1`; an atomic group-sequence management lifecycle is Phase 2B2.

---

## 2026-08-27 — Owner booking alerts use a transactional occurrence outbox

**Status.** Approved by the Product Owner after live salons reported missing
new-booking and reschedule email alerts.

**Decision.** A canonical future booking insert, or a real future start-time
change, records one owner-notification occurrence in the same database
transaction. The existing notification cron leases those occurrences and the
existing per-recipient provider claim remains the idempotency barrier. Booking
success never waits for email; the outbox can retry definite pre-acceptance
failure at most twice and never retries an ambiguous provider outcome.

- Group bookings record only the organizer row and carry the party size.
- Inline and worker senders resolve the same occurrence key, preventing a race
  from producing duplicate manager emails.
- Provider-accepted completion requires an existing Resend receipt in the
  recipient claim ledger.
- A newer unsent reschedule suppresses older mutable material; no historical
  booking is backfilled or blindly resent.
- Wix/Square imports retain their existing bounded per-sync alert caps. A bulk
  provider import must not become an unbounded email backlog.
- The outbox and its claim/completion functions are service-only with RLS and
  explicit browser-role denial.

**Release boundary.** Apply and verify the additive migration before enabling
the worker in production. A code-first preview fails closed when the RPC is not
present. Production migration, provider email proof, merge and deployment each
remain separately approval-gated.

---

## 2026-08-27 — Every booking gateway declares one orchestrated canonical route

**Status.** Approved by the Product Owner in chat: “Hãy đồng bộ hết” and
“Hãy làm theo đề xuất.”

**Decision.** Every booking-capable gateway must enter through the shared
`bookingOrchestrator` policy before it can quote, commit or reconcile a
booking-shaped record. The orchestrator owns the gateway-to-channel and
intent-to-engine mapping; adapters retain only authentication, input
normalization and provider-specific translation.

- Online, Desk and Voice route individual appointments to
  `canonical_individual` and groups to `canonical_group`.
- Walk-in routes to `operational_queue`; it is not disguised as a scheduled
  individual appointment.
- Wix and Square route to `provider_reconciliation`; provider imports retain
  their exact external identity and reconciliation rules rather than bypassing
  them through a public customer RPC.
- Chat is `assist_only`. It cannot quote, commit or reconcile a booking until a
  separately approved release expands that capability.

**Safety boundary.** The orchestrator is additive and runtime-neutral. It does
not replace the already-proven canonical RPCs, weaken Desk membership/role
checks, change booking states, contact providers, or add a database migration.
A committed booking receipt remains authoritative; card management and other
post-commit work may remain pending without turning the booking into failure.

---

## 2026-08-22 — AI text/background provider timeout policy

**Decision.** Non-streaming Anthropic text/background work has a 20-second
deadline per provider attempt and disables implicit SDK retries. Current direct
and cron-driven agents do not add an automatic retry; any future durable
scheduler may retry at most once and must retain the same logical job identity.

On timeout, telemetry records `provider_timeout`, measured latency, zero known
tokens, and unknown provider cost. The timed-out provider result must not be
treated as successful evidence or authorize a downstream send or mutation.

Streaming agents keep a separate timeout policy. Nail Try-On keeps its existing
45-second provider request, 45-second status poll, and 180-second operation
deadline policy.

---

## 2026-08-22 — Tips are verified staff money; commission is an estimate, not payroll

**Status.** Approved by the Product Owner for the full-feature launch scope.

**Tip decision.** A verified collected tip belongs 100% to staff. When more
than one staff member serves a booking, the exact cents are allocated in
proportion to each service's after-discount value, using largest-remainder
rounding so no cent is created or lost.

**Commission decision.** Commission is a reporting estimate only and must
never be represented as payroll, payout authorization or money owed. Its basis
is after-discount service revenue and excludes tax and tips. Each salon owner
supplies an effective-dated basis-point rate; NailIQ has no invented default
rate.

**Corrections.** Refunds and manual adjustments append immutable debit/reversal
evidence. Historical credit rows are never edited or deleted. Cumulative
clawback calculation and transaction locking prevent rounding drift, replay and
concurrent over-reversal.

**Security and evidence.** Policy approval is owner-only. Evidence mutation is
service-role-only through tenant-checked RPCs; the underlying forced-RLS tables
are not browser-readable or directly mutable. Local migration, report/parser,
rollback, concurrency and security-advisor gates do not prove provider,
deployment, payroll or live-salon behavior.

---

## 2026-08-22 — Multi-location data is shared only inside an explicit salon organization

**Status.** Approved by the Product Owner for the full-feature launch scope.

**Decision.** A business chain is an explicit `salon_organization`. A salon may
belong to at most one organization. Staff identity, consented customer profile
access, shared loyalty and aggregate reporting may cross salon boundaries only
inside that organization. Salons outside it remain isolated even when the same
phone number or login appears in both businesses.

**Fail-closed rollout.** Existing salons are not auto-linked. Existing global
`client_profiles` rows are not auto-shared. Organization-level customer access
requires an active consent row and an existing salon-client relationship at a
location in the organization. Revocation stops organization profile listing;
the immutable loyalty history remains retained for accounting integrity.

**Staff scheduling.** One organization-level person maps to separate
salon-scoped `staff` assignments. Each location retains its own timezone and
shift rows. Transaction-scoped advisory locking prevents one shared person from
receiving overlapping live bookings at different locations, including the
single-booking and service-segment scheduling models.

**Loyalty and reporting.** Chain loyalty uses an atomic, idempotent ledger that
retains the earning/redeeming salon. Earn events require a completed booking;
one redemption consumes the configured reward threshold. Reporting returns
separate branch rows and one organization total without returning customer PII.

**Security.** New tables use forced RLS, explicit least-privilege grants and no
anonymous access. Authenticated users receive read-only organization rows via
membership policies; organization creation verifies owner access to every
requested salon. Customer and reporting functions repeat the organization
membership check, while loyalty mutation remains service-role-only.

**Implementation evidence.** Migration
`20260822155809_add_salon_organization_multilocation.sql` and the two disposable
rehearsals under `scripts/security/` cover two independent chains, two linked
locations with different timezones, cross-tenant denial, customer consent,
shared staff overlap, loyalty replay/concurrency and branch/aggregate reports.
No production schema, provider or live salon is changed by this decision.

---

## 2026-08-03 — Rule-first paid-AI optimization is opt-in and fail-safe

**Decision.** `salons.feature_flags.ai_rule_first_optimization` gates all new
cost-saving behavior. When absent or false, no-show policy, Digest, and Watchdog
keep their previous paths. When true:

- no-show risk uses the deterministic scorer and calls the policy model only in
  the ambiguous 50–69 band; a skipped/limited/failed model call always falls
  back to the existing deterministic card rule;
- Digest uses AI only when actions, alerts, approvals, or unclosed appointments
  need judgment; otherwise it still sends a deterministic daily summary;
- Watchdog calls AI only for a deterministic material signal (sync failure or
  staleness, unprotected high risk, no-show spike, or material demand drop);
- every paid call first claims an atomic, PII-free per-salon slot in Postgres.

**Rollback.** Set `ai_rule_first_optimization=false` for the salon. No schema
rollback or booking mutation is required. The durable claims then become inert
and expire naturally.

**Safety.** Limits fail closed for paid AI but fail open to deterministic salon
behavior. They never block bookings, charge money, send campaigns, or disable
the existing no-show protection rule.

---

## 2026-07-30 — Lifecycle telemetry does not use server actions

**Decision.** Dashboard activity-count polling uses a read-only API GET, and
presence heartbeat uses a same-origin API POST. Neither lifecycle effect
imports or dispatches a Next server action.

**Why.** A production-only diagnostic on the exact PR #1103 deployment mapped
the two automatic POSTs preceding React error 310 to
`getActivityUnreadCount` and `upsertPresence`. Both were mounted in the shared
dashboard shell and dispatched during hydration. The dense AI Control Center
made the App Router race reproducible, while lighter dashboard routes could
finish hydration before the same background work completed.

**Safety.** The activity endpoint is read-only, owner/admin-gated by the
existing loader, validates its timestamp, and is never cached. The presence
endpoint requires same-origin POST, bounds its path/battery input, derives the
user agent from the request, and keeps the existing authenticated RLS write.
The temporary action-ID log is removed in the same change.

---

## 2026-07-30 — Keep AI mutations out of the rendered App Router action queue

**Decision.** AI Control Center submits its owner-initiated mutations through
one same-origin JSON API. Client-rendered controls no longer import server
action references. The API validates the operation and identifiers, preserves
the existing tenant/role checks inside each mutation, and returns the existing
result contract.

**Why.** Exact production verification of PR #1101 disproved the lifecycle
refresh hypothesis: the page still failed with React error 310 inside Next's
root `useActionQueue` on a clean authenticated document load, while another
dashboard route on the same deployment rendered without errors. The remaining
AI-specific App Router input was the set of server action references embedded
in this unusually dense client surface. A normal fetch keeps those mutations
outside the hydration action queue without reducing product capability.

**Safety.** The endpoint rejects missing or cross-origin mutation requests,
validates action-specific identifiers and operations, and delegates
authorization, tenant isolation, state transitions, idempotency, and audit
behavior to the existing server implementations. It does not add any messaging,
campaign dispatch, payment, pricing, or destructive authority.

---

## 2026-07-30 — Keep lifecycle refreshes out of the App Router queue

**Decision.** AI Control Center keeps its one-minute freshness interval, but a
stale snapshot now reloads the document. It no longer dispatches
`router.refresh()` or refreshes immediately from `visibilitychange`.

**Why.** PR #1100 proved that wrapping the lifecycle dispatch in
`startTransition` did not stop React error 310. On its exact production
deployment, a clean authenticated load still produced two POST requests to the
AI route before the Next App Router action queue failed. Background freshness
does not need to share the same action queue as hydration. A bounded document
GET makes that separation explicit and retains the promised one-minute update.

**Tradeoff.** A stale visible AI Control Center performs a full document reload
instead of a seamless React Server Component merge. This can reset transient
local UI state, but it occurs at most once per minute and avoids crashing the
whole page. User-initiated approval and execution controls retain their
transitioned server actions.

**Safety.** Authorization, approval, execution, messaging, payment, pricing,
and persistence behavior are unchanged. E2E must prove the automatic request
is a document GET rather than an RSC request, and exact production browser
verification remains mandatory.

---

## 2026-07-30 — Schedule AI Control Center background refreshes as transitions

**Decision.** Keep the one-minute freshness policy, but wrap its
`router.refresh()` dispatch in React `startTransition`.

**Why.** Production browser verification on the exact PR #1099 deployment
showed the AI route returning HTTP 200, followed immediately by a POST to the
same App Router route and React error 310 inside Next's action queue. CI had
already proved the page and a delayed client navigation on a production build;
the remaining production-only trigger was the page's lifecycle-driven
background refresh dispatch. A background refresh is non-urgent work and must
not interrupt the router's initial render.

**Safety.** This does not alter authorization, approval, execution, messaging,
payment, pricing, or persistence behavior. The stale threshold and polling
interval are unchanged. Production browser verification remains required
because endpoint health cannot detect a client router failure.

---

## 2026-07-30 — Keep App Router on patched React and Next releases

**Decision.** Pin Next.js 16.2.12 with React and React DOM 19.2.8, and exercise
AI Control Center through a deliberately delayed client-side route transition
in E2E.

**Why.** Production verification exposed React error 310 in the framework
App Router while a non-prefetched AI route was waiting for its Flight response.
The route returned HTTP 200 and server health remained green, so endpoint-only
checks could not detect the broken UI. Patch-level framework/runtime upgrades
plus a slow-navigation test cover the actual browser failure mode.

**Safety.** This changes no NailIQ product authority, data model, migration,
RLS, authentication policy, messaging, booking, payment, pricing, approval, or
execution behavior. The versions remain exact-pinned and the complete build,
unit, smoke, visual, and E2E gates remain required.

---

## 2026-07-30 — Owner AI observability rows are bounded display models

**Decision.** AI activity and operational exception loaders rebuild explicit
owner-facing rows before passing them to Client Components. Activity labels,
customer names, action types, and previews are normalized and length-bounded.
Operational exception queries select only rendered lifecycle fields, omit
internal kind/source references and unused timestamps, and bound all narrative
text.

**Why.** These surfaces previously avoided serializing complete database rows,
but still accepted unbounded strings derived from AI payloads and selected
internal exception metadata that the browser never used. Operational
observability is not a reason to widen the server/browser trust boundary.

**Safety.** The owner still sees the same actionable status, severity,
description, occurrence count, timestamps, resolution note, and guarded
lifecycle controls. No exception transition, AI execution, messaging, booking,
payment, pricing, authentication, schema, or RLS authority changes.

---

## 2026-07-30 — Owner approval rows exclude raw action payloads

**Decision.** Owner-facing approval queries omit capability tokens and
notification metadata, then rebuild an explicit browser row. Client Components
receive only the approval identity and lifecycle fields they render, verified
decision provenance, and bounded bilingual action intelligence. Raw payloads,
tenant IDs, internal actor IDs, recipient details, and delivery metadata remain
server-side.

**Why.** Removing approve/decline tokens alone was insufficient because the
previous `ApprovalDisplayRow` spread every other database field into Client
Component props. That serialized the complete action payload—including
potential recipient and provider data—plus internal tenant and notification
metadata even though the UI never rendered most of it. An AI control plane must
make its server/browser contract explicit instead of depending on components
to ignore sensitive fields.

**Safety.** The server still uses the payload to derive owner-facing reason,
evidence, expected impact, confidence, and reversibility. Those values are
bounded before serialization, while raw arrays and unknown fields are dropped.
This changes no approval decision, execution, messaging, booking, payment,
pricing, authentication, schema, or RLS authority.

---

## 2026-07-30 — Approval inbox keeps source failures distinct from empty state

**Decision.** The owner approval page loads approval requests and execution
evidence independently. If approval reads fail, the page explicitly reports
that the waiting count is unverified and does not render the successful empty
state. If execution reads fail, decisions remain visible but approved rows are
marked unverified; only a successful execution read with no matching job is
reported as a missing execution trace.

**Why.** An unavailable database read does not prove there are zero approvals,
and an unavailable queue read does not prove an approved decision lacks a job.
Collapsing either failure to an empty array makes the control plane look safe
precisely when its evidence is incomplete. Owners must still be able to see and
act on available approvals without mistaking partial data for operational
truth.

**Safety.** Both reads remain tenant-scoped, bounded, and server-side. The
change adds no approval, execution, messaging, booking, payment, pricing,
authentication, schema, or RLS authority. It changes only failure isolation
and owner-facing truthfulness.

---

## 2026-07-30 — Owner surfaces receive a minimized execution view

**Decision.** AI Control Center and the approval dashboard load execution jobs
through an owner-specific server projection. The browser receives only the job
identifier needed for guarded controls, approval identifier, action type,
lifecycle status, bounded attempts, a safe failure code, creation time, and
allowlisted aggregate campaign summaries. An approved decision without a queue
job is displayed as an integrity issue.

**Why.** The internal queue row contains operational credentials and sensitive
implementation data: tenant IDs, payloads, idempotency keys, lease tokens,
lease timing, raw results, recipient manifests, plan fingerprints, and
technical errors. TypeScript types alone do not stop a Server Component from
serializing those values into Client Component props. Selecting a narrow
projection and rebuilding the result from explicit allowlists makes the
server/client boundary enforceable and testable.

**Safety.** The query remains tenant-scoped and bounded. Raw error text is
converted to an approved failure category before serialization. Campaign
summaries contain counts, caps, freshness, cost estimates, and no-send proof;
recipient details, provider data, manifest contents, plan IDs, and fingerprints
are dropped. This changes no queue execution, approval, messaging, payment,
authentication, schema, or RLS behavior.

---

## 2026-07-30 — Recent approval decisions expose execution integrity

**Decision.** AI Control Center loads execution traces for the exact bounded
set of recent decisions inside the active salon. Declined and expired requests
state explicitly that no execution occurred. Approved requests show the real
queue lifecycle; if no corresponding job can be proven, the UI reports an
integrity issue instead of implying success. A trace read failure is a separate
unavailable source and never becomes an empty or healthy state.

**Why.** Approval provenance proves who authorized an action, but authorization
is not evidence that a job was created or an effect happened. Joining only
against the newest general queue rows can also omit a recent decision in a busy
salon. An operating system must connect decision intent to authoritative
execution evidence without making the owner infer the gap.

**Safety.** The read is tenant-scoped and restricted to at most twenty trusted
approval IDs. The browser receives only approval ID, lifecycle status, bounded
attempt counts, a sanitized blocker category, and timestamps. Raw payloads,
results, errors, internal job IDs, idempotency keys, and lease credentials stay
server-side. This adds no execution, messaging, booking, pricing, payment, or
authentication authority.

---

## 2026-07-29 — AI operating permissions are atomic and auditable

**Decision.** Owner/admin AI agent toggles execute through one service-only
Postgres function. The function validates the actor and canonical impact,
locks the salon, updates exactly one flag, and writes an append-only permission
audit before the transaction can succeed.

**Why.** The previous Server Action performed a read-modify-write on the whole
`feature_flags` object and ignored the read error. Two concurrent toggles could
overwrite each other, while the generic salon audit could not prove the
specific permission, acknowledged impact, or previous state. TypeScript and a
confirmation dialog are not sufficient control-plane evidence.

**Safety.** The application still authenticates and authorizes the caller
before using the service client; Postgres repeats the membership and impact
checks. The function is revoked from public, anonymous, and authenticated
roles. Replays that request the current state write neither the salon nor a
duplicate audit. No agent is enabled by this migration.

---

## 2026-07-29 — AI agent activation discloses and confirms operating impact

**Decision.** Every owner-facing AI agent has one allowlisted impact class.
Enabling an agent that can contact customers or change live booking protection
requires explicit acknowledgement in both the UI and Server Action. Runtime
flag keys are validated before membership resolution or any write.

**Why.** Several agents described themselves as draft-only or universally safe
to enable even though their current handlers can send capped SMS/email or
change card/deposit requirements. TypeScript cannot validate values crossing a
Server Action boundary. An operating system must state what a control does and
fail closed when sensitive activation intent is missing.

**Safety.** Disabling remains one tap. Monitoring, draft-only, and owner-only
agents do not gain extra friction. The change does not enable any flag or run
an agent, and existing enabled salons remain unchanged.

---

## 2026-07-29 — Control Center freshness follows tab visibility

**Decision.** AI Control Center re-runs its existing authenticated Server
Component snapshot every minute while the document is visible. A
`visibilitychange` back to a stale tab refreshes immediately. Hidden tabs do
not poll, and both the interval and event listener are removed on unmount.

**Why.** Queue jobs, approvals, worker heartbeats, and operational exceptions
change independently of owner interaction. A server-rendered snapshot that
remained frozen until manual reload could present a recovered issue as failed
or a new exception as absent, undermining the page's role as an operating
surface.

**Safety.** Refresh uses `router.refresh()` and therefore reuses all existing
session, role, feature, tenant, and fail-honest read boundaries. It adds no
browser data API, mutation, execution, messaging, payment, pricing, booking, or
authentication authority.

---

## 2026-07-29 — Machine-signaled exceptions own recovery truth

**Decision.** Operational exceptions sourced from AI execution, AI Manager, or
production readiness may be acknowledged by an owner/admin, but cannot be
manually resolved or reopened. Their existing firing/recovered signal owns the
terminal transition. Human-owned and legacy watchdog exceptions keep their
audited manual resolve/reopen controls.

**Why.** The inbox previously allowed an owner to mark an exhausted execution
job or failed agent as resolved while the source was still failing. That made
the exception row contradict queue and operating-health truth. Acknowledgement
records human awareness without claiming technical recovery.

**Safety.** The replacement RPC remains security-invoker and service-role-only,
locks one salon-scoped row, and preserves the existing PII-free audit. It
removes manual authority from machine-owned recovery and adds no execution,
messaging, booking, payment, pricing, or authentication authority.

---

## 2026-07-29 — Worker diagnostics use a privacy-safe failure boundary

**Decision.** All AI worker heartbeat writers pass failure values through one
allowlist before the durable worker state and append-only run history are
updated. The execution cron returns the same safe code while logging the raw
exception only server-side. Control Center translates recognized codes and
masks any unknown historical heartbeat value.

**Why.** Protecting execution-job errors alone left a second path where raw
database/provider text could be stored in `ai_execution_worker_state` and
rendered to an owner. Operating health needs actionable status, not internal
exception bodies.

**Safety.** Scheduler fencing, run history, retry limits, leases, approvals,
and effects are unchanged. This grants no messaging, booking, payment, pricing,
authentication, or execution authority.

---

## 2026-07-29 — Execution failures expose safe codes, not raw internals

**Decision.** The AI execution worker writes only an allowlisted operational
error code to `ai_execution_jobs.last_error` and the durable action audit. Raw
database/provider errors remain in server-side logs for investigation. Owner
surfaces translate known codes to operational guidance and render a generic
message for unknown historical values instead of echoing stored text.

**Why.** A dependency error can contain SQL details, provider responses,
identifiers, or customer data. Persisting that string into a tenant-visible job
and then rendering it in the Control Center turned an internal diagnostic into
an avoidable disclosure boundary.

**Safety.** Retry limits, leases, approval authority, and execution effects are
unchanged. This narrows persisted and displayed diagnostics; it grants no new
messaging, booking, payment, pricing, authentication, or execution authority.

---

## 2026-07-29 — Control Center metrics count beyond preview limits

**Decision.** “Needs your decision” uses an exact count of all pending
approvals while rendering only a bounded newest-pending preview. “30-day
actions” uses Supabase's exact count for the same filtered 30-day query while
retaining at most 200 rows for the activity preview and outcome calculations.
If an exact count is unavailable, that source fails explicitly and the Control
Center renders the partial-data state introduced in PR #1078.

**Why.** The previous metrics counted the arrays sent to the browser. They
therefore capped approvals at 100 and actions at 200, and an older pending
approval could fall outside a mixed-status approval preview. Preview limits are
performance controls, not business totals.

**Safety.** Both additions are tenant-scoped, read-only aggregate queries. They
grant no execution, messaging, booking, pricing, payment, authentication, or
production-mutation authority.

---

## 2026-07-29 — AI Control Center reports partial read failure explicitly

**Decision.** The owner-facing AI Control Center loads approvals, activity,
execution jobs, operating health, and operational exceptions as independent
settled sources. A failed source is logged server-side and rendered as
temporarily unavailable; its metrics use an em dash and its section never
claims zero work, an empty queue, or healthy operation. Sources that loaded
successfully remain usable.

**Why.** Several service-role readers previously discarded Supabase errors and
returned empty arrays or zero counts. A database or schema failure could
therefore produce reassuring but false UI such as “No decisions are waiting,”
“No AI activity,” or “AI is operating normally.” An operating system must
distinguish observed zero from unavailable evidence.

**Safety.** This is read-path truthfulness only. It grants no execution,
messaging, booking, pricing, payment, authentication, or migration authority.

---

## 2026-07-29 — Daily digest delivery is provider-acknowledged and replay-safe

**Decision.**
- A daily digest uses one stable provider idempotency key per salon-local day.
- Missing recipients, missing provider configuration, and provider rejection
  are failures rather than successful `digest_sent` claims. A deliberately
  disabled owner-notification channel remains an intentional no-op.
- After the provider accepts the email, one service-role-only transaction
  records the durable delivery, marks the normal approvals actually included
  in that email as notified, and appends the AI activity audit.
- Replaying the database acknowledgement cannot create a second salon-day
  delivery or duplicate activity claim.

**Why.** Production had pending approvals included in daily digests while their
`notified_at` fields remained empty. The old path also appended `digest_sent`
after the send function returned even when notifications were disabled, no
recipient existed, or Resend rejected the request. NailIQ must not confuse an
attempt with a delivered owner communication, and a retry after an ambiguous
network/database boundary must not send a second digest.

**Safety.** This changes the accounting and retry behavior of the existing
one-per-day digest only. It does not enable a notification channel, add
recipients, send campaigns, authorize approval decisions, or grant messaging,
booking, pricing, payment, authentication, or security authority.

---

## 2026-07-29 — Hydration readiness is observed without rendering test UI

**Decision.** Receptionist Center publishes its post-commit E2E readiness on a
window-scoped test signal. The Playwright helper waits for that signal after the
visible schedule and walk-in form gates. No readiness node is rendered into the
React tree.

**Why.** PR #1077's production-build trace showed React invariant `#418`
immediately before the former `rc-hydrated` child appeared. The marker's
effect-backed state update could insert a child into the streamed parent while
lower Suspense descendants were still hydrating. The failure repeated on the
targeted job rerun even though the PR did not change Receptionist UI.

**Correction after the targeted rerun.** Removing the rendered marker improved
test observability but did not eliminate `#418`, so it was not the root cause.
Inspection of the actual server HTML then found inline Start `<button>` elements
nested inside booking `<button>` elements. The browser repaired that invalid
HTML before hydration, so React received a different tree. Booking blocks with
the independent Start action now use a keyboard-accessible button-like
container around the inner real button. The same persisted-interface E2E then
passed on the PR and on production `main`.

**Coverage.** The persisted-interface E2E continues to reject hydration errors
across initial Classic load, Preview reload, and Classic reload. The readiness
signal only changes test observability; it does not change booking, queue,
message, payment, permission, or authentication behavior.

---

## 2026-07-28 — Live Board hydration uses one server-owned clock snapshot

**Decision.** Receptionist data includes the exact server observation timestamp.
The Live Board uses that serialized instant for its server render and first
client render, then starts its minute clock only after hydration. Client-only
enhancements no longer force synchronous root updates merely to publish an E2E
marker, expose `window.location.origin`, or report a redundant hydration flag.
E2E readiness is published outside the rendered React tree after commit.

**Why.** Production on the exact PR #1074 deployment reproduced React hydration
invariant `#418` on `/center` in both the New and Classic interfaces. The board
previously rendered time-dependent children with an empty clock and immediately
replaced it in an effect. It also redundantly replaced the complete server-data
state from a mount effect even though that state had already been initialized
from the same payload. With streamed/selective hydration, either parent update
could occur while lower time-dependent content was still hydrating, producing
a text mismatch even though a later DOM snapshot looked correct. Server data is
now adopted only when a later refresh carries a new observation timestamp.
Wait-link origin is read only after the operator clicks. E2E gates interactions
on a window-scoped post-commit signal; unlike the old rendered marker or
external-store snapshot, it cannot change the server or first-client tree.

**Coverage.** The persisted-interface E2E captures React hydration errors across
initial load, New-interface reload, and Classic-interface reload.

**Safety.** The timestamp is operational display state only. This changes no
booking, queue, message, payment, permission, or authentication behavior.

---

## 2026-07-28 — Disabled Insights stays inside the dashboard render tree

**Decision.** When `advanced_reports` is disabled for a salon, the authenticated
Insights route renders a stable, data-free “not enabled” state inside the
dashboard instead of throwing `notFound()` after dynamic auth and salon reads.

**Why.** Production evidence after PR #1073 proved the HTTP redirect itself was
correct, but every direct visit to disabled Insights still persisted React
invariant `#310`. The page visibly rendered the global 404 and browser console
capture was empty, yet the application error boundary recorded the App Router
hook-order failure on the exact deployed chunk. Keeping the result in one
server-rendered dashboard tree avoids the dynamic 404 transition.

**Safety.** The disabled state contains only existing localized copy and no
report snapshot, customer data, revenue, staff performance, execution
permission, or upgrade action. Feature-enabled salons retain the unchanged
owner/admin report loader and plan gates.

---

## 2026-07-28 — Reports data exists before client hydration

**Decision.** The Reports Server Component loads the initial `today` snapshot
through a `server-only` report loader before rendering the client panel. The
client contains no Server Action reference; an explicit date-range change uses
a same-origin, non-cacheable GET route which calls that same authenticated
loader. The customer-identity E2E is part of the CI matrix and repeats the
Reports route assertion in WebKit.

**Why.** Production verification after PR #1066 reproduced React invariant
`#310`. The first repair removed unnecessary component memo hooks, but fresh
production loads after PRs #1067 and #1068 still failed. The production stack
located the throwing `useMemo` inside Next.js App Router; after #1068 the
remaining Reports-specific integration with that router was the client-imported
Server Action proxy. Chromium CI also initially gave false confidence because
the identity spec was absent from the workflow's explicit path matrix. Removing
the Server Action boundary entirely keeps report reads out of the action queue;
explicit WebKit coverage tests the engine where the failure was observed.

**Safety.** Date-range changes retain bounded, latest-request-wins loading.
Report queries, permissions, identity resolution, bookings, messaging, and
financial behavior remain unchanged.

---

## 2026-07-28 — Identity revocation changes trigger-visible state first

**Decision.** The identity-revocation transaction locks and validates the
active salon alias, marks it inactive, and only then restores matching bookings
to the alias profile.

**Why.** The booking canonicalization trigger runs before every booking update.
When revocation restored bookings while the alias remained active, that trigger
immediately changed the profile back to canonical. The RPC still returned
success, producing a false Undo. Running the previously omitted E2E in both
Chromium and WebKit exposed the persisted-data mismatch.

**Safety.** The function remains owner-checked, salon-scoped,
`SECURITY DEFINER`, and executable only by `service_role`. The order change is
inside one transaction; a failed booking update rolls back alias deactivation.
It does not delete profiles, bookings, aliases, or audit history.

---

## 2026-07-28 — Analytics follow reviewed customer identity

**Decision.**
- Owner customer counts and staff repeat-client metrics use the booking's
  canonical `client_profile_id`, with normalized phone only as a fallback for
  legacy bookings without a finalized profile.
- AI outcome tracking resolves a historical action phone through the salon's
  active identity alias before looking for a return booking.
- Alias lookup failures stop outcome processing instead of silently recording
  a false non-conversion.

**Why.** Reversible identity review deliberately preserves the phone submitted
with each booking while assigning the booking to one canonical profile. Phone-
grouped analytics would therefore split a reviewed customer back into multiple
people and teach the AI from incorrect return behavior.

**Safety.** This is read-only analytics behavior. It does not merge profiles,
rewrite bookings, send messages, change prices, or create financial effects.
Revoking a merge restores the alias profile on affected bookings, so subsequent
analytics naturally return to separate identities.

---

## 2026-07-28 — Manager-owned agents must fail visibly

**Decision.** Every top-level agent invoked by the AI Manager cron must rethrow
unexpected failures after logging them. Expected feature gates, deduplication,
missing optional providers, and other intentional no-op paths may still return
normally.

**Why.** The Manager can only record an agent as failed, sync its durable
exception signal, and fail its worker heartbeat when the awaited agent rejects.
Swallowing an unexpected database, provider, or delivery error makes the
orchestration report `ok` even though the agent did not complete.

**Caller impact.** These entry points are Manager-only except
`runDailyReport`, whose manual test-report action already catches a rejection
and returns `send_failed`. No autonomous-send permission or campaign behavior
changes.

**Guardrail.** `managerAgentFailureBoundary.spec.ts` enumerates every currently
managed entry point that owns a top-level catch and requires its log boundary to
rethrow. Manager route tests separately prove a rejected agent produces a
failed result, a failed heartbeat, and no raw error leakage.

---

## 2026-07-28 — Scheduler liveness waits until a first run is due

**Status.** Implemented on `agent/cron-first-run-grace`.

**Decision.**
- A worker with no recorded run is `pending`, not `missing`, while its first
  freshness window is still open after cron monitoring begins.
- Recorded failures are never softened by this grace period.
- Once that worker's freshness window expires, no observation becomes a real
  `missing` incident.
- System Health reports healthy, pending, and attention counts separately.

**Why.** Five daily workers correctly had no history a few hours after
production-wide cron recording was deployed, but System Health labeled all five
as incidents and then called the remaining eleven workers unhealthy by
implication. An operating system must distinguish “not scheduled yet” from
“missed its schedule” without hiding actual failures.

**Activation evidence.** The earliest valid start among recorded workers is
used as the beginning of observable monitoring. This requires no hardcoded
deployment timestamp and naturally expires into the existing missing-worker
alarm.

---

## 2026-07-28 — Error fingerprints preserve stable React invariant codes

**Status.** Implemented on `agent/error-code-fingerprint`.

**Decision.**
- A minified React invariant number is included separately in the production
  error fingerprint before variable numbers are normalized.
- Variable booking IDs, UUIDs, addresses, and decoder query details still
  normalize so repeated instances of the same error shape group together.
- Route, surface, and severity remain part of the fingerprint.

**Why.** Numeric normalization is useful for high-cardinality business IDs, but
React's production error number is diagnostic evidence rather than instance
data. Removing it can group unrelated failures such as hook ordering (`#310`)
and hydration (`#418`) when they occur on the same route, again giving
operators and AI remediation a mixed record.

**Migration behavior.** No historical data is rewritten. The first recurrence
after deployment creates a correctly scoped group; later identical occurrences
increment it normally.

---

## 2026-07-28 — Autonomous error remediation fails closed on contradictory evidence

**Status.** Implemented on `agent/error-evidence-gate`.

**Decision.**
- Before AI triage or a draft fix, the stored error route must agree with the
  pathname in the latest captured href.
- A contradictory legacy row receives a deterministic explanation; no model,
  repository read, GitHub write, or draft PR is attempted.
- System Health displays the conflict and removes the triage and draft-fix
  controls while preserving manual resolve/ignore controls.
- Missing evidence remains visible but is not labeled as a proven conflict.

**Why.** Before route-aware fingerprints were deployed, one row could retain
the first event's route while its context was replaced by a later occurrence
from another route. Feeding that mixed record to AI produced a confident but
unsupported component-level fix. Autonomous remediation must stop when its
primary evidence contradicts itself rather than convert ambiguity into code.

**Recovery.** Historical rows are not rewritten. A new occurrence uses the
route-aware fingerprint and creates internally consistent evidence that can be
triaged safely.

---

## 2026-07-28 — Production errors are grouped by route as well as message

**Status.** Implemented on `agent/error-fingerprint-route`.

**Decision.**
- The self-hosted error fingerprint includes the bounded request route in
  addition to level, surface, and normalized message.
- Variable identifiers inside a message still normalize together when the
  error occurs on the same route.
- The exact bounded route written to the error record is also the route used to
  compute its fingerprint.

**Why.** Technical evidence exposed a grouped React `#418` row whose stored
route was `/choose-salon` while its latest context href was
`/dashboard/hilite-anaheim/center`. The database kept the first occurrence's
route but refreshed context on later occurrences because the fingerprint
ignored route. That contradictory record led AI triage to recommend fixing the
wrong component. Route-aware grouping keeps evidence internally consistent and
lets future occurrences identify the actual failing surface.

**Migration behavior.** Existing grouped rows remain as historical evidence.
New occurrences use the route-aware fingerprint and naturally create a
correctly scoped row; no production data rewrite or destructive migration is
required.

---

## 2026-07-28 — Error remediation starts from stored technical evidence

**Status.** Implemented on `agent/fix-choose-salon-hydration`.

**Decision.**
- The superadmin-only System Health error view loads and exposes the stack and
  bounded context already stored with each application error.
- Technical evidence remains collapsed by default and is never added to public
  error responses or salon-facing surfaces.
- AI summaries and suggested fixes remain visible, but operators can compare
  them with the actual stack, route, href, and user-agent evidence before
  accepting a remediation.

**Why.** The active React hydration alert on `/choose-salon` had been assigned a
specific component-level explanation by AI even though the operator surface
showed only the minified message. Source review did not support that conclusion.
An AI operating system must distinguish evidence from inference; otherwise it
can confidently repair the wrong component and create a new regression.

**Access boundary.** Loading stack/context still requires an authenticated
superadmin role before the service-role client is constructed. Tests prove that
an unauthenticated caller cannot reach the evidence query.

---

## 2026-07-28 — Public salon routes reject impossible slugs before data access

**Status.** Implemented on `agent/public-slug-boundary`.

**Decision.**
- A public booking slug must match the same lowercase ASCII word-and-single-
  hyphen grammar produced by salon registration.
- Malformed route segments return the existing not-found outcome before a
  Supabase query or similar-slug search is constructed.
- Valid unknown slugs still perform the normal existence lookup and may offer
  suggestions; database failures remain distinct from genuine not-found
  results so live salons are not incorrectly de-indexed.

**Why.** Production operating records showed internet scanners requesting
segments such as `wp-config.php.bak`. The previous boundary checked only length,
so impossible salon names reached Supabase and could turn provider/WAF
responses into noisy application errors. Rejecting syntax that registration
can never create protects database capacity and keeps operator alerts focused
on real customer traffic.

**Compatibility.** All five current production salon slugs and every slug
produced by `slugifySalonName` satisfy the grammar. This does not alter valid
salon URLs, booking data, authentication, messaging, or financial behavior.

---

## 2026-07-28 — Every scheduled route has a fail-honest operating record

**Status.** Implemented on `agent/cron-run-history`.

**Decision.**
- All 16 Vercel cron entry points use one fixed worker allowlist and persist a
  fenced start plus append-only terminal run outcome.
- The 14 previously untracked routes enter a shared wrapper only after central
  cron authorization. If their start cannot be recorded, their work does not
  run invisibly.
- Non-success HTTP responses and handler exceptions persist bounded internal
  categories; raw provider errors, customer data, and message bodies are never
  added to the scheduler ledger.
- The SuperAdmin System Health surface evaluates each deployed cron against an
  explicit freshness contract and distinguishes healthy, running, failed,
  stale, and never-observed workers.
- The AI Control Center continues to calculate its two AI-specific reliability
  metrics from only `ai_execution` and `ai_manager` runs.

**Why.** Authentication and configuration readiness prove that Vercel may call
the routes, not that every scheduler is actually running successfully.
Previously 14 routes could stop silently while the system still appeared
healthy. A nail-salon operating system needs a durable, operator-visible record
for reminders, integrations, waitlist, notifications, learning, cleanup, and
the AI workers alike.

**Safety.** This adds observability and fail-honest fencing only. It does not
invoke a cron manually, authorize campaign delivery, send a message, change a
booking, charge or refund a customer, or modify authentication.

---

## 2026-07-28 — Readiness includes cron authorization configuration

**Status.** Implemented on `agent/cron-readiness-gate`.

**Decision.**
- `/api/ready` reports cron authorization as a separate bounded check.
- A missing or whitespace-only `CRON_SECRET` makes the deployment not ready
  even when the database schema is current and reachable.
- The response reports only whether configuration is present; it never returns
  the secret, its length, or any derived credential material.

**Why.** Every scheduled HTTP entry point now fails closed without its shared
secret. Database readiness alone could therefore report a healthy operating
system while all autonomous schedulers were unable to run. Deployment
readiness must cover the credential required to invoke the AI operating loop.

---

## 2026-07-28 — Liveness and production readiness are separate contracts

**Status.** Implemented on `agent/production-readiness-gate`.

**Decision.**
- `/api/health` remains a dependency-free liveness probe: it answers only
  whether the deployed web runtime is serving requests.
- `/api/ready` uses a fixed, no-write service-role probe to prove both database
  connectivity and the latest schema capability required by the deployed app.
- The readiness probe supplies no request data, cannot match a real job, expects
  the explicit `job_not_preparable` result, times out after three seconds, and
  returns bounded error categories without provider or schema details.
- Missing or stale schema returns HTTP 503 even while liveness remains HTTP 200.

**Why.** PR #1033 initially reached production while its required migration was
still absent. A healthy Node.js response therefore overstated release health.
Separate probes let deployment verification detect code/schema skew without
turning a transient database incident into a false claim that the web process
itself is down.

**Safety.** The probe uses constant impossible UUIDs and a zero-recipient
summary. It cannot update an execution job, add an audit row, select a customer,
or contact a provider.

---

## 2026-07-28 — Audience preparation is one atomic, idempotent transition

**Status.** Implemented on `agent/atomic-audience-preparation`.

**Decision.**
- A service-role-only RPC locks the tenant-scoped `waiting_input` bulk-message
  job, validates a bounded aggregate summary, updates the job, and records its
  audit event in one transaction.
- Concurrent or repeated preparation with the same audience fingerprint is a
  no-op and cannot create duplicate audit claims.
- The fingerprint covers both each eligible profile identity and its resolved
  SMS/email channel, so a channel-consent change produces a new preparation.
- The job remains `waiting_input` with `no_messages_sent: true`; preparation is
  not dispatch authorization.

**Why.** The previous two-call update could persist a prepared audience without
its audit event, and retries could create duplicate audit rows. Counts alone
also hid channel changes when the same people remained eligible. NailIQ must
make every claimed operating transition transactionally true and replay-safe.

---

## 2026-07-28 — Approval-to-effect must be proven through the real runtime path

**Status.** Implemented on `agent/approval-effect-e2e`.

**Decision.**
- The E2E suite creates a reversible internal operational-note approval in a
  throwaway local Supabase database.
- A browser first opens the token with GET and proves no decision or job is
  created, then submits the real same-origin POST confirmation.
- The test invokes the authenticated execution cron with a random per-run
  secret and verifies the durable job, leased attempt, atomic audit-note effect,
  terminal success, and replay idempotency from the database.
- All provider credentials remain empty and outbound SMS/calls remain disabled.

**Why.** Unit tests and static migration assertions prove individual contracts
but not that the deployed route, database transition, worker, and effect compose
correctly. An operating system needs one fail-closed full-path proof without
contacting a real customer or mutating production.

---

## 2026-07-28 — Approval links require an explicit POST confirmation

**Status.** Implemented on `agent/approval-post-confirmation`.

**Decision.**
- Opening an approval link with GET is read-only and only renders the proposal.
- The owner must explicitly submit a same-origin POST before the decision is
  recorded and an approved action can enter the execution queue.
- Token pages are not cached, indexed, or allowed to leak their URL as a
  referrer. Dashboard links also disable framework prefetching.

**Why.** Email security scanners, link preview services, and browser prefetching
can follow GET links without human intent. A state-changing GET could therefore
approve or decline an AI action. The POST boundary makes owner confirmation
observable and mandatory.

---

## 2026-07-28 — Approval UI separates decisions from execution outcomes

**Status.** Implemented on `agent/approval-queue-truth`.

**Decision.**
- The approval page loads owner decisions and execution jobs in parallel and
  joins them by `approval_request_id`.
- Pending actions say “approve and queue” rather than claiming they execute
  immediately.
- Approved actions expose the real queue lifecycle: queued, waiting for input,
  running, succeeded, failed, or canceled, including bounded attempt and error
  information when available.

**Why.** An approval is authorization to begin governed execution; it is not
proof that the effect already happened. The operator UI must preserve that
distinction so owners can trust what NailIQ says it has done.

---

## 2026-07-28 — Structural strategist advice enters the governed execution loop

**Status.** Implemented on `agent/strategist-operational-note-proposals`.

**Decision.**
- The hourly AI Manager looks for the latest real
  `strategist/escalate_structural` activity from the previous 14 days.
- A service-role-only database function creates one pending
  `record_operational_note` approval linked to that exact source activity.
- A partial unique index on `source_action_id` prevents duplicate approvals
  across cron retries, overlapping runs, and later reprocessing.
- The source foreign key is retained for auditability; deleting a source cannot
  silently remove the deduplication identity.
- The proposal expires after seven days and records bounded reasoning,
  evidence, expected impact, confidence, and reversibility.

**Why.** The queue had a safe real operational-note effect, but no legitimate
producer connected strategist analysis to the owner decision. This closes that
gap without turning an AI recommendation into an automatic action.

**Safety.** The producer creates only an owner decision. It cannot execute the
note, send messages, change bookings or prices, charge customers, or alter
authentication. The existing approval transition and leased execution worker
remain mandatory.

---

## 2026-07-28 — Operational notes are NailIQ's first safe real execution effect

**Status.** Implemented on `agent/operational-note-effect`.

**Decision.**
- An owner-approved `record_operational_note` job writes an
  `approved_operational_note` entry to the salon's AI activity log and marks the
  leased job succeeded in one database transaction.
- The action-specific RPC requires the exact running job and lease token. A
  stale or overlapping worker cannot execute or finish a newer attempt.
- A partial unique index on `(agent, action_type, target_id)` makes the effect
  idempotent across retries, timeouts, and lost responses.
- Notes are trimmed, must be non-empty, and are capped at 1,000 characters.
  Invalid payloads are canceled honestly instead of producing a fake success.
- AI Control Center renders the persisted note in the existing activity stream.

**Why.** The queue previously returned a successful internal-audit result
without creating the promised operational record. A real operating system must
distinguish a planned effect from an effect that was committed, and it must
commit the effect and lifecycle transition atomically.

**Safety.** This is an internal, reversible-by-follow-up-note record only. It
does not send messages, mutate bookings, change pricing, charge customers, or
alter authentication.

---

## 2026-07-28 — Preserve scheduler run history and measure reliability

**Status.** Implemented on `agent/ai-worker-run-history`.

**Decision.**
- Persist one service-role-only `ai_worker_runs` row for every execution worker
  and AI Manager run instead of relying only on mutable last-known heartbeat
  state.
- Record the start before work begins and the terminal outcome through the same
  fenced heartbeat RPC. An overlapping older run may finish its history row but
  cannot overwrite the newer current heartbeat.
- Store bounded internal error categories only. Raw provider errors, customer
  data, message bodies, and credentials do not belong in scheduler history.
- Show the last 24 hours of completed-run reliability separately for the
  execution worker and AI Manager. Running jobs are observed but excluded from
  the success-rate denominator.
- Treat “no completed runs” as unknown coverage, not as 0% or 100% reliability.

**Why.** A last-known heartbeat proves whether a scheduler is alive now, but a
later success overwrites evidence of an earlier failure. NailIQ needs durable
run outcomes to distinguish “healthy now” from “reliably healthy over time”
without inventing reliability where no completed runs exist.

**Safety.** This milestone adds observability only. It grants no messaging,
payment, pricing, booking, authentication, or campaign authority.

---

## 2026-07-28 — AI Manager orchestration is fail-honest

**Status.** Implemented on `agent/ai-manager-heartbeat`.

**Decision.**
- The hourly AI Manager records a fenced start and terminal heartbeat before
  and after orchestrating salon agents.
- Missing cron configuration or unavailable heartbeat persistence stops work
  before any agent runs.
- Partial agent failures produce a failed manager heartbeat and a non-success
  HTTP response instead of being hidden behind an overall success.
- Persisted summaries contain counts and bounded `salon:agent` identities, not
  raw exception bodies.
- AI Control Center evaluates the execution worker on a 15-minute freshness
  window and the hourly manager on a 2-hour freshness window.

**Why.** A healthy execution queue does not prove that Radar, reports,
win-back, SIP refresh, strategist, and the other scheduled agents are being
orchestrated. The operating system needs separate evidence that both the action
executor and the manager brain are alive.

---

## 2026-07-28 — Outcome metrics use concluded measurement windows

**Status.** Implemented on `agent/honest-outcome-measurement`.

**Decision.**
- Customer return rates include only actions whose configured measurement
  window has concluded.
- Pending actions remain visible but are excluded from the rate denominator.
- Overall and per-agent metrics expose measurement coverage.
- Product copy calls the metric an observed return rate and explicitly avoids
  claiming that AI caused a later booking.

**Why.** Including pending actions understates results before clients have had
time to respond. A booking after an AI action is also observational attribution,
not proof of causation. NailIQ must communicate both limits instead of
presenting false precision.

---

## 2026-07-27 — An idle queue is healthy only when the worker is alive

**Status.** Implemented on `agent/ai-execution-heartbeat`.

**Context.** AI Control Center could expose failed jobs and expired per-job
leases, but it could not distinguish a genuinely idle queue from a scheduler
that had stopped invoking the execution cron. Queued work could therefore look
active indefinitely while the worker itself was silent.

**Decision.**
- Every authorized execution-cron invocation records a fenced start and either
  a success summary or a bounded failure reason in one service-role-only
  singleton.
- A newer overlapping run replaces the run token. An older run cannot overwrite
  the newer heartbeat when it eventually completes.
- The worker fails closed when it cannot record its start; AI work never runs
  invisibly outside the operating record.
- AI Control Center reports missing, failed, and older-than-15-minute
  heartbeats as an operating issue even when no individual job is running.
- The heartbeat adds no messaging, payment, pricing, booking mutation, or
  authentication authority.

---

## 2026-07-27 — Execution leases fence stale AI workers

**Status.** Implemented on `agent/ai-execution-leases`.

**Context.** The execution worker previously claimed work with an optimistic
update, then completed the job and wrote its audit event in separate calls. If
an attempt ran longer than the recovery window, a second worker could recover
and reclaim it while the original worker was still alive. The original worker
could then overwrite the newer attempt because completion was guarded only by
`status = running`.

**Decision.**
- Every claim receives a unique 15-minute lease token. Only the worker holding
  the current token may finish that attempt.
- Claiming uses `FOR UPDATE SKIP LOCKED`, so concurrent cron invocations divide
  ready work without waiting on or duplicating one another.
- Claim, recovery, completion, and their matching audit events are database
  transactions exposed only to the service role.
- Expired recovery clears the old token before a retry can be claimed. A late
  worker treats a rejected token as stale and never converts it into another
  failure or overwrites the current state.
- Retry limits and the outbound-effect allowlist remain unchanged. This adds no
  messaging, payment, pricing, booking-mutation, or authentication authority.

---

## 2026-07-27 — Approval and execution enqueue are one atomic transition

**Status.** Implemented on `agent/atomic-approval-execution`.

**Context.** Approval persistence and execution enqueue previously happened in
two database calls. A queue failure could leave an owner decision marked
`approved` with no execution job, and revisiting the one-tap link treated that
state as already complete instead of repairing it.

**Decision.**
- A service-role-only, security-invoker RPC locks the approval row, validates
  that the supplied token matches the requested decision, persists the decision,
  creates the idempotent execution job, and writes its audit event in one
  transaction.
- Declines are also persisted with their audit event atomically.
- Revisiting the approve link for a historical approved row with no job safely
  creates the missing job once. Existing jobs remain unchanged.
- Proposal-preference learning stays post-commit and advisory; its failure
  cannot reinterpret or roll back the owner's decision.
- This transition adds no sender, campaign, payment, pricing, or authentication
  authority.

---

## 2026-07-27 — Owners can recover failed AI work without bypassing execution safety

**Status.** Implemented on `agent/ai-execution-recovery`.

**Context.** AI Control Center accurately exposed queued, failed, and stalled
work, but an owner could not resolve a failed or no-longer-wanted job from the
same operating surface. Recovery required database intervention, so the control
center was observability without operational control.

**Decision.**
- Owners/admins may retry only a `failed` job that remains below its bounded
  attempt limit. Retry returns it to `queued`; the worker still owns execution.
- Owners/admins may cancel `queued`, `waiting_input`, or `failed` work. Running
  work cannot be canceled because its external effect may already have started;
  succeeded/canceled states remain terminal.
- A service-role-only, security-invoker RPC locks the tenant-scoped job and
  writes its transition plus `ai_actions_log` row in one database transaction.
  Public, anonymous, and authenticated Data API roles cannot execute the RPC.
- The Server Action independently resolves the salon and verifies owner/admin
  membership before calling the RPC. Stale UI actions return `invalid_state`
  rather than overwriting a concurrent worker transition.
- Retry/cancel adds no new sender, payment, pricing, authentication, or campaign
  authority.

---

## 2026-07-27 — AI operating state must be measured, tenant-scoped, and honest

**Status.** Implemented on `agent/ai-operating-health`.

**Context.** AI Control Center showed recent jobs, but owners could not tell
whether the execution system was healthy, actively working, waiting for safe
input, or carrying a hidden failure. Learned cooldowns and outcome-based pace
reductions altered behavior without an owner-facing explanation.

**Decision.**
- Queue health uses exact, salon-scoped counts for queued, waiting-input,
  running, and failed jobs. A running lease older than the worker's 15-minute
  recovery threshold is explicitly reported as stalled.
- Status severity is deterministic: failed/stalled → issue; waiting input →
  attention; queued/running → active; otherwise healthy. A failed job is never
  presented as completed or silently omitted.
- Owner-facing learned controls include only active lessons belonging to that
  salon. Global and cross-salon lessons are excluded, and expired proposal
  cooldowns are filtered at read time.
- The surface explains temporary proposal cooldowns and bounded contact-cap
  reductions. It is read-only and adds no execution, messaging, payment, or
  authentication authority.

---

## 2026-07-27 — Owner decisions must alter proposal frequency without permanently muting AI

**Status.** Implemented on `agent/approval-preference-learning`.

**Context.** A declined approval created a new `policy` lesson, but the weekly
strategist never read policy lessons. The system therefore claimed to learn while
repeating the same approval pattern. Creating one permanent suppression lesson
per decline would overreact to a single decision and could never recover.

**Decision.**
- Resolved weekly-strategist approvals are evaluated inside the same salon,
  action type, and proposal source. Unrelated bulk-message workflows cannot
  teach this policy.
- Two declines among the latest three resolved decisions activate one
  deterministic `proposal_cooldown` lesson for 28 days. Fewer than three
  decisions do not change behavior.
- Two consecutive approvals recover the learned cooldown. The gap between
  activation and recovery is deliberate hysteresis.
- During an active cooldown, strategist analysis and read-only recommendations
  may still run, but no repeated approval request is created. The suppression is
  written to `ai_actions_log` with its lesson and expiry.
- The expiry is enforced at read time, so a stale lesson cannot permanently mute
  proposals even if a cleanup cron is delayed.
- This mechanism only removes future proposals. It adds no sender, execution
  permission, payment behavior, or authentication authority.

---

## 2026-07-27 — Outcome adaptation must change behavior, stay bounded, and recover

**Status.** Implemented on `agent/ai-outcome-adaptation`.

**Context.** The learning cron aggregated conversion outcomes, but the result did
not reliably affect agent behavior. Newly sent actions omitted `payload.phone`,
so the outcome tracker could not associate them with later bookings. The old
analysis also reduced confidence on broad lessons that were not necessarily
owned by the low-performing agent.

**Decision.**
- Every trackable customer action records the canonical customer phone in its
  audit payload. Historical rows recover phone from `winback_suggestions`,
  `first_visit_sequences`, or `client_profiles` using tenant-scoped batch reads.
- A 30-day sample of at least 10 resolved actions activates an agent-specific
  `segment` lesson below 5% conversion. The lesson applies
  `cap_multiplier:0.5`; a 10% recovery threshold deactivates it. The 5–10% gap
  provides hysteresis.
- Learned caps are bounded to 25–100% of the code cap and may never raise a cap
  or stop an agent entirely. Winback, rebook, first-visit nudges, and VIP Care
  all consume the same helper.
- The adaptive lesson uses a deterministic UUID and primary-key upsert, making
  concurrent cron retries idempotent. Audit rows are written only when the
  active state actually changes.
- No sender, channel permission, campaign authorization, pricing behavior, or
  payment behavior is added by this loop.

---

## 2026-06-19 — Minh Learning Loop Bước 3: approval_requests + owner notification (§3D + §3E)

**Status.** Migration applied to prod (`fshmobzyjhmtvndobwsy`). Code in `feat/minh-approval-requests`.

**Context.** Per SPEC §3D-3E. "Không để việc chờ duyệt nằm im" — urgent actions email owner immediately with one-tap approve/decline; normal ones batched into 21:00 digest.

**Decision.** `approval_requests` table (urgency/approve_token/decline_token/expires_at); `/api/ai/approve?token=...` for no-login decision; dashboard `/approvals` page; declined → lesson `policy` scope with confidence 0.7.

- **Token auth:** each row has two opaque 64-hex tokens (approve / decline). Knowing the token IS the authorization — no login required. Tokens are single-use (status flips to approved/declined immediately).
- **Expiry:** urgent defaults 4h, normal 48h. Cron `minh-learn` marks expired rows + sends one reminder after 24h.
- **Learning loop:** a decline auto-creates a `minh_lessons` entry (`scope=policy`) so Minh reduces proposals of that action type.
- **Digest integration:** normal-urgency pending approvals appear in the 21:00 digest email with inline one-tap buttons (same token URLs).

---

## 2026-06-19 — Minh Learning Loop Bước 2: feedback signals (channel failures + outcomes)

**Status.** Code in `feat/minh-feedback-loop`.

**Context.** Per `SPEC-minh-learning-loop §3B`. Closes the loop: Twilio failure rates and agent conversion outcomes now flow back into `minh_lessons` automatically.

**Decision.**
- `analyzeChannelFailures()`: queries `booking_notifications` for a salon's last 7d SMS sends. If fail rate >50% and sample ≥5, auto-creates a `channel` lesson (`prefer_email`). Uses error codes 30034/30007 (A2P carrier rejection) as additional failure signals. Idempotent — skips if an active lesson already exists.
- `analyzeAgentOutcomes()`: reads `ai_actions_log` outcomes for last 30d. Agents with <5% conversion rate (min 10 resolved actions) trigger a `decreaseLessonConfidence()` call (delta 0.05) on any `timing`/`channel`/`segment` lessons scoped to them. Minor delta by design — needs sustained poor performance to deactivate.
- `lessonMutations.ts`: `createLesson` / `decreaseLessonConfidence` / `deactivateLesson` helpers. Lessons auto-deactivate when confidence drops below 0.2. Source field preserves deactivation reason for audit trail.
- `channelCostTracker.ts`: per-channel cost accumulator (SMS ~$0.0079, email ~$0.001) — feeds digest in a future step.
- Both analysers run in daily cron `/api/cron/minh-learn` at 03:00 UTC. Summary logged to `ai_actions_log` when lessons change.
- Code guardrails in `channelResolver.ts` remain as backstop.

---

## 2026-06-19 — minh_lessons: lesson store for AI learning loop (Bước 1)

**Status.** Migration applied to prod. Code in `feat/minh-lessons`.

**Context.** Per `SPEC-minh-learning-loop §3A`. Converts hardcoded guardrails into DB records that agents read before acting, enabling runtime rule changes without deploys.

**Decision.** `minh_lessons` table (scope/condition jsonb/rule/confidence) + `getLessons()` + `findChannelLesson()`. Agents call `getLessons()` first then fall through to code guardrails as backup. Lesson #1 (A2P) seeded as the canonical example. `agentWinback` wired as proof-of-concept: reads channel lessons once per run, logs `lesson_id` when a lesson blocks SMS for a candidate.

---

## 2026-06-19 — A2P guardrail: US SMS auto-routes to email until registered (Minh lesson #1)

**Status.** Code in PR `fix/minh-a2p-sms-guardrail` (draft). Stopgap live: Hi-Lite `sms_outbound_enabled` set FALSE via Supabase MCP on 2026-06-19.

**Context.** Live QA found the AI Manager ("Minh") winback agent sent **13 real SMS** to US customers for `hilite-anaheim`, a salon with `sms_a2p_registered = false`. US A2P 10DLC unregistered SMS is silently carrier-dropped and can still incur Twilio fees. The system *recorded* `sms_a2p_registered = false` but **did not act on it** — routing used only the manual `sms_outbound_enabled` flag (default TRUE), which nobody had flipped. `channelResolver.ts` explicitly noted the A2P flag "does NOT control routing." Net: Minh measured outcomes but had no feedback loop to stop a known-bad channel — it would repeat for the next US salon.

**Decision.** Wire the compliance flag into routing so the system self-protects:
- `resolveCustomerChannel` gains optional `smsA2pRegistered` + `customerPhone` (default to pre-guardrail behaviour → existing callers unchanged). When the destination is a **US** number (`isUsPhone`, new `src/shared/lib/phoneRegion.ts`) **and** `smsA2pRegistered === false`, SMS is treated as unavailable → smart mode falls back to email (`email_a2p_fallback`).
- Non-US numbers (CA/VN/etc.) and A2P-registered salons are unaffected.
- Wired into `agentWinback` first (the agent that fired). **Follow-up:** wire the same params into `agentFirstVisit`, `agentRebook`, `vip_care`, reminders, `sendReviewRequest` (tracked in `docs/SPEC-minh-learning-loop.md`).

**Why this is "lesson #1".** It is the first concrete instance of turning an incident into a durable, system-enforced rule rather than a one-off manual fix — the seed of the Minh learning loop (see SPEC). One incident → one guardrail that can never silently repeat.

**Verification.** `npm run typecheck` green. Preview-first (cost/customer path): merge after PM review. Check Twilio Console messaging logs (17–18/06) for the 13 sends' error codes (30034 = blocked) + price.

---

## 2026-06-19 — Duplicate booking-confirmation emails + wrong salon name

**Status.** Code in PR `fix/duplicate-confirmation-email` (draft). Migration index `booking_notifications_confirmation_once` applied to prod via Supabase MCP.

**Context.** Live booking on `hilite-anaheim` produced **2 identical confirmation emails** (1s apart), both titled with the slug `hilite-anaheim` instead of "Hi-Lite Head Spa". Root cause: `sendBookingConfirmationEmail` selected a non-existent `currency` column (real: `currency_code`) → salon lookup errored → `salonRow = null` → (a) the email notification log was skipped, defeating the `/api/booking/sms-confirm` dedup guard (which counts email rows) so both it and `publicBookingSideEffects` sent; (b) the email fell back to slug name / Vancouver tz / CAD.

**Decision.** `currency` → `currency_code`; plus a race-proof claim-before-send (`claimNotificationOnce` + partial unique index on `(booking_id, channel) where notification_type='booking_confirmation'`). First sender wins, the other skips.

---

## 2026-05-06 — Demo registration is restricted to a single shared `demo-salon`

**Status.** Resolved by PR #16 (`cd4a948`).

**Context.** The demo-cookie security guard (originally added in PR #4, then rolled back because it broke real owners with non-`demo-salon` slugs) only trusts the `demo-salon` slug. Without a companion fix, demo-mode registrations could create salons at any name-derived slug — and `pickAvailableSalonSlug` would happily suffix `demo-salon-2`, `demo-salon-3`, etc. once the canonical slug was taken — making the cookie guard impossible to re-introduce safely. Tracked across multiple sessions as the "companion fix" backlog item.

**Decision.** Demo mode is restricted to a single shared salon at the constant `DEMO_SALON_SLUG` (= `"demo-salon"`). Production behavior is unchanged because `isDemoOtpRuntime()` returns `false` whenever `DEMO_OTP=false` (or unset with `NODE_ENV=production`).

**Implementation.**

1. **Slug picker (`src/shared/register/salonSlugPicker.ts`).** `pickAvailableSalonSlug` short-circuits to `{ slug: DEMO_SALON_SLUG, slugAdjusted: false }` whenever `isDemoOtpRuntime()` is true. The DB uniqueness search and `-2`/`-3` candidate loop are skipped entirely. Caller-supplied salon names are ignored under demo mode.

2. **Server action (`src/shared/register/completeSalonRegistrationAction.ts`).** The demo branch checks for an existing `demo-salon` salon row before insert. If present (i.e. created on a prior demo registration; all demo users share a single demo owner via `getOrCreateDemoSalonOwnerUserId`), the salon/services/staff/salon_members inserts are skipped — only the completion-token delete and the demo cookie set still happen, then the action returns the existing slug. This is what makes a second-and-onward demo registration succeed without tripping the `salons.slug` unique constraint.

3. **Client component (`src/app/register/setup/RegisterSetupInner.tsx`).** Accepts a server-resolved `isDemoMode` boolean prop, threaded through `page.tsx`. In demo mode the salon-name input is pre-filled with "Demo Salon" (which slugifies to `demo-salon`), set `readOnly`, the slug preview is overridden to `DEMO_SALON_SLUG`, and the existing copy is replaced with: *"Demo mode uses shared salon: demo-salon. The name and slug aren't configurable in this build."* Server action remains authoritative — bypassing the `readOnly` attribute still results in slug `demo-salon` because the picker forces it.

**Hydration safety.** `isDemoMode` is resolved server-side in `page.tsx` via `isDemoOtpRuntime()` and passed as a prop to the client component. Calling `isDemoOtpRuntime()` directly inside the client would risk a server/client mismatch when only the server-only `DEMO_OTP` is set without `NEXT_PUBLIC_DEMO_OTP` — the prop pattern eliminates that ambiguity.

**Production inertness.** All four added code paths are gated behind `isDemoOtpRuntime()`. With `DEMO_OTP=false` (or unset) on Vercel, none of them execute — production registration still derives slugs from the salon name with the same `-2`/`-3` collision suffixing as before.

**Follow-up (separate PR, deferred).** Re-introduce the demo-cookie scope guard rolled back in PR #4. The `slug === DEMO_SALON_SLUG` check is now safe because demo registrations cannot drift to any other slug. Track in a future "security: re-add demo cookie scope guard" PR — it should be a minimal revert-of-the-revert plus an updated comment in `middleware.ts` linking to this entry.

**Related.** Commits `cd4a948` (merge), `0b54d01` (commit). PRs #4 (rolled-back guard), #16 (this fix). Constants: `DEMO_SALON_SLUG` in `src/shared/lib/demoOtpMode.ts`.

---

## 2026-05-04 — Migration tracking out of sync; `db push` blocked until reconciled

**Status.** Resolved on 2026-07-23 by PRs #912 and #913.

**Context.** nailiq runs against a single Supabase project (`nailiqOS`, ref `fshmobzyjhmtvndobwsy`). There is no separate test project — E2E and production share the DB. On 2026-05-04 we ran `npx supabase migration list` and discovered significant drift between local migration files and the remote `supabase_migrations.schema_migrations` tracking table.

**Findings.**

- 13 local migration files are **not recorded** as applied on the remote tracking table — but E2E tests (run #21) pass, so the schema *is* present on prod. Most likely applied via the dashboard SQL editor or by earlier `db push` runs that did not update tracking.
- 1 remote-only stale entry: `20260428`. This is the pre-rename id of `register_completion_tokens.sql`. Today's commit `7de1124` renamed the file to `20260428130000_register_completion_tokens.sql`; remote still tracks the old id.

The 13 local-only entries:

- `20260428130000_register_completion_tokens` (this is the rename)
- `20260430180000_*` (one of two duplicate-timestamp files; see note in step 2)
- `20260430210000`, `20260430220000`, `20260430230000`
- `20260430240000` (×2 files, same id — see step 2 note)
- `20260430250000`, `20260430260000`
- `20260502120000`, `20260502130000`
- `20260503140000`, `20260503210000`

**Risk.** Running `npx supabase db push` now would attempt to re-execute the SQL for all 13 entries — including `CREATE TABLE` and similar statements for objects that already exist on prod. Likely partial-transaction failures, possibly destructive depending on how each migration is written.

**Decision.**

1. Block `npm run db:push` with a guard script (`scripts/db-push-guard.js`) that exits non-zero with a pointer to this entry. Direct `npx supabase db push` calls remain technically possible — the guard is convention, not enforcement — but it stops accidental `npm run` invocations.
2. Reconcile via `supabase migration repair`, **not** by re-running SQL.
3. Only after reconciliation, replace the guard with the real command.

**Reconcile plan.**

### 1. Backup

Take a logical dump of prod before touching the tracking table.

```
mkdir -p backups
npx supabase db dump --linked > backups/nailiqos-pre-reconcile-$(date +%Y%m%d-%H%M).sql
```

Verify the file is non-empty and contains recent table definitions (`grep -c CREATE backups/nailiqos-pre-reconcile-*.sql`). Keep the dump out of git (already covered by `.gitignore` patterns; verify before committing anything else).

### 2. Repair the 12 truly-applied entries

For each timestamp below, first verify the corresponding schema is in fact present on prod (Table Editor or `\d <table>` via the SQL editor in the Supabase dashboard). Then mark applied without re-running:

```
npx supabase migration repair --status applied <timestamp>
```

Repeat for: `20260430180000`, `20260430210000`, `20260430220000`, `20260430230000`, `20260430240000`, `20260430250000`, `20260430260000`, `20260502120000`, `20260502130000`, `20260503140000`, `20260503210000`.

That is 11 distinct timestamps covering 12 files (the two `20260430240000` files share an id). The rename (`20260428130000`) is handled separately in step 3.

*Duplicate-timestamp note.* The CLI tracks by id, so only one row is needed in the tracking table per id. The two `20260430240000` files will both appear "applied" via the single repair entry. Going forward, avoid creating two migrations with the same timestamp — the apply order between them is filesystem-dependent.

### 3. Repair the rename

```
npx supabase migration repair --status reverted 20260428
npx supabase migration repair --status applied 20260428130000
```

### 4. Verify

```
npx supabase migration list
```

Expect: every Local row has a matching Remote row; no orphans on either side.

```
npx supabase db diff --linked
```

Expect: empty diff. If non-empty, prod schema differs from local files in some way the tracking table doesn't capture — investigate before proceeding.

### 5. Test

Trigger the E2E workflow on `main`:

```
gh workflow run e2e.yml
```

Wait for green. If it fails with schema-related errors, the assumption that "schema is fully present on prod" was wrong — at least one local migration was never actually applied. Stop, identify which, and apply only that one via `db push --include-all=false` with explicit selection (or run the SQL manually via the dashboard editor) before re-running step 4.

### 6. Unblock safely

The historical plan to replace the guard with a raw `supabase db push` command
was superseded. `npm run db:push` now runs a pinned CLI through
`scripts/db-push-safe.mjs`: it first proves the local history is an exact
extension of the audited production ledger, always performs a linked dry-run,
and changes production only when both `--apply` and
`NAILIQ_DB_PUSH_APPROVAL=APPLY_REHEARSED_MIGRATIONS` are present.

The folded baseline was rehearsed on an empty database in PR #912. Production
recorded only the history marker in a guarded transaction; its schema SQL was
not executed. PR #913 then locked the repaired ledger at strict 267/267 parity.
The 266-row pre-repair backup remains available for rollback.

**Related.** Commits `7de1124` (rename that exposed the drift), `06e9463` (CI env vars), `a381d92` (Edit perms scope). Discovery from `npx supabase migration list` output captured in chat on 2026-05-04.

---
