# P1-02 — Head Spa and legacy card-protection exceptions (2026-09-14)

## Scope and evidence class

- Isolated branch: `audit/p1-02-head-spa-20260914`
- Base and current Production SHA: `f0b49628e8aa35e6cf4a97b369a160ff531c04bc`
- Production inspection: read-only aggregate queries; no customer name, phone, email,
  card identifier, customer identifier, or provider secret was returned.
- Provider calls, messages, charges, booking mutations and Production writes: none.
- Publication status: implementation committed as
  `fe2caa552c1f574c476a602f0767dcd4f2895b7a`, pushed to
  `audit/p1-02-head-spa-20260914`, and opened as PR #1408.
- Isolated QA Preview: deployment `dpl_FbmD5riF8pzYhXZEX7XDcVXizZm4` on project
  `nailiq-sdk-save-qa-20260912`; target `preview`, state `READY`.

## Production truth at 2026-09-14 21:36 UTC

| Salon | Future non-cancelled | Future exceptions | Saved and active | Required without card | Potentially chargeable |
|---|---:|---:|---:|---:|---:|
| Hi-Lite Head Spa | 13 | 5 | 2 | 4 | 0 |
| Hi-Lite Studio | 4 | 4 | 0 | 4 | 0 |

The nine future exceptions are confirmed appointments. Eight are `awaiting_card`
with no card/customer/brand/last4/consent and no save-card operation. One Head Spa
appointment is correctly `manual_review`: the booking has card display fields and one
`succeeded` operation, but its provider/customer binding does not match and its consent
policy version is not a current `nsp_<sha256>` receipt. It must not be called protected
or retried by blindly creating another card.

There are 662 additional past exceptions: 508 at Head Spa and 154 at Studio. They are
completed, no-show, or past confirmed appointments. They cannot activate protection for
an appointment that has already passed and should not occupy the owner's active exception
queue. Provider-operation diagnostics remain durable outside this UI projection.

Both salons use Square and have no-show protection enabled. No booking in the inspected
set had a pending or processing no-show charge. Application charge paths separately
require `card_protection_status = 'saved'`; the legacy Head Spa row remains
`manual_review` despite its older `noshow_charge_status = 'saved'` value.

## Root cause and local fix

`loadCardProtectionExceptions` excluded only `cancelled` bookings. It therefore returned
completed, no-show and past confirmed appointments as if their card protection still
needed appointment-time action.

The local query now returns only future `pending` or `confirmed` bookings in an inactive
card-protection state. Tenant, owner/admin, minimal-disclosure and provider-reconciliation
boundaries are unchanged.

## Verification

| Gate | Result |
|---|---|
| Focused unit test | PASS — 8/8 |
| Real Supabase QA Auth/integration | PASS — 13/13 |
| Past completed exception in real QA Postgres | PASS — excluded while two future exceptions remained visible |
| Two-tenant and six-role access matrix | PASS — only Owner/Admin of the matching salon received the list |
| Retry-link race | PASS — three simultaneous actions returned one durable capability |
| Demotion, membership removal and session revocation | PASS — access removed immediately |
| QA outbound/payment boundary | PASS — SMS, email, call and payment dispatch remained disabled |
| QA cleanup | PASS — zero active memberships, undeleted bookings, unexpired capabilities or enabled outbound flags |
| Touched-file ESLint | PASS |
| Next production build | PASS |
| TypeScript `tsc --noEmit` after build | PASS |
| QA Preview build and `/api/health` | PASS — deployment READY and health returned `status: ok` |
| Real-browser public UI smoke | PASS — NailIQ login rendered with zero browser console errors |
| Authenticated Owner Preview | PASS — the exception panel rendered two future exceptions and excluded the past completed fixture |
| Minimal disclosure on Preview | PASS — masked customer labels rendered; synthetic full names, phone and email were absent |
| Owner actions on Preview | PASS — two Open booking, two secure-retry and two Mark reviewed controls rendered; one retry capability and one reviewed state persisted |
| Preview auth rate limit | PASS — the shared QA auth bucket returned HTTP 429 after its configured threshold; QA-only hashed auth buckets were reset once to complete this controlled test |
| Current-HEAD Square Sandbox backend | PASS — 8/8 executed scenarios on `522069fd`; the ninth recovery-only test was intentionally skipped in the normal run |
| Current-HEAD provider delivery truth | PASS — real Sandbox success, decline, before-dispatch timeout, response loss, DB loss before/after completion, a 12-request idempotency race and customer-authority isolation all passed |
| Real-browser synthetic Head Spa recovery | PASS — Chrome loaded the secure retry link, saved a Square Sandbox Visa, displayed `Card protection active`, and preserved that state after reload |
| Browser-to-database receipt | PASS — the synthetic booking remained `confirmed`, protection became `saved`, card/customer binding, brand/last4, consent timestamp and policy hash were present, and its single operation was durably `succeeded` |
| Browser provider-mutation boundary | PASS — one search, one customer create and one card create; zero charge/read-reconciliation calls and no duplicate provider mutation |
| Browser sensitive-log scan | PASS — no configured provider secret, authorization header, source token, PAN, full email or phone pattern was found in the application log |

The first build attempt failed before compilation because Turbopack rejects a
`node_modules` symlink outside the worktree root. Installing the lockfile dependencies
inside the worktree resolved the environment issue; the unchanged build command then
passed.

The first authenticated Preview attempts were blocked by the disposable QA environment's
already-exhausted shared-IP `public-edge:auth` buckets. Direct QA Auth succeeded with the
same synthetic credentials. After resetting only those hashed QA auth buckets, the real
browser reached the Owner page and verified the panel and actions above. Vercel Preview
toolbar CSP warnings and cancelled speculative requests were observed; neither prevented
the application panel or its server actions from completing. Cleanup then confirmed zero
active memberships, live bookings and active capabilities for the synthetic fixture.

The current-HEAD provider run used a newly migrated disposable Supabase stack, synthetic
customer data, Square Sandbox and a restrictive outbound boundary. NailIQ SMS, email and
call delivery remained disabled, and no payment charge endpoint was allowed. The backend
suite ended with ten confirmed and protected synthetic bookings, ten succeeded operations,
three closed failed historical attempts, and no `sending` or `unknown` operation. The
browser run added one separate synthetic Head Spa booking and performed exactly one
customer/card creation pair. This proves the recovery mechanism on the current PR code;
it does not prove that the nine existing Production exceptions have been contacted or
recovered.

## Remaining operational acceptance

1. Review PR #1408 before any merge or Production release.
2. Owner reviews the eight future `awaiting_card` appointments and generates secure,
   expiring retry links only for the intended customers.
3. The one Head Spa `manual_review` appointment must collect fresh policy consent and use
   read-only Square verification of the existing card before any new tokenization.
4. Obtain explicit Production authorization before generating or delivering retry links
   for the nine existing live-salon exceptions. The equivalent synthetic Head Spa journey
   has passed in real Chrome and Square Sandbox; no live customer was changed or contacted.

## Verdict

- Existing Production charge safety: **PASS**
- Local exception-list defect and regression: **PASS**
- QA Auth, tenant, race and cleanup: **PASS**
- QA Preview build/API/public UI smoke: **PASS**
- Authenticated Owner exception-list and action verification on Preview: **PASS**
- Synthetic Head Spa provider recovery journey on current HEAD: **PASS**
- Existing live Head Spa/Studio exception recovery: **NOT RUN — requires Production authorization**
- P1-02 code and QA acceptance: **PASS**
- P1-02 operational Production completion: **NOT YET COMPLETE**
