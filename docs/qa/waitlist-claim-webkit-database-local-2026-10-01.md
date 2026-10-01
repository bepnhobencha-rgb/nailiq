# Waitlist Claim Recovery — real WebKit and local database (B56)

Date: 2026-10-01. Status: **TESTED LOCALLY**, not deployed or pilot-proven.
Day 22 remains **NOT_CLOSED**; Master Plan remains **NOT_PROVEN**.

## Scope and environment

- Candidate HEAD: `e2680aa7a779448940ba597317e908c503089a66`, detached composite with unpublished changes. This is not a clean published PR head.
- Actual WebKit engine, emulated iPhone SE, iPhone 14 Pro Max, and iPad (gen 7).
- Actual NailIQ Next dev/Webpack route → local restricted RPC gateway → PostgREST → PostgreSQL.
- No API response mocks, React/storage injection, hosted credentials, provider requests, customer data, or Production changes.
- Reused the owned B54 synthetic database; added cases 6–8 only. Existing cases 1–5 were retained.
- Fault proxy drained actual successful HTTP 200 responses after commit, then closed the browser connection. It did not forge a successful booking response.

## Results

| Scenario | Actual claim POSTs | Dropped committed responses | New confirmed bookings | Durable claim receipts | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| SE: claim by keyboard, response lost, reload, recovery response lost, reload, explicit recovery | 3 | 2 | 1 | 1 | PASS local |
| Pro Max: normal claim, acknowledged reload | 1 | 0 | 1 | 1 | PASS local |
| iPad: claim response lost, reload, explicit recovery | 2 | 1 | 1 | 1 | PASS local |

Each scenario used exactly one request-ID hash across its retries. All six claim RPC responses were HTTP 200. Each of the three new entries ended `claimed`, with exactly one booking and one receipt. The four previously completed B54 entries retained their one booking and one receipt. The original unclaimed B54 entry was not treated as a successful test.

The corrected harness captured **15 successful UI checkpoints across three scenarios**; these are not 15 independent end-to-end scenarios. No skipped checkpoints or failed commands in the corrected run. Reload checks asserted unchanged POST counts. Every captured state had zero horizontal overflow, zero runtime page errors, and no Next error overlay. Operational buttons were fully in the viewport and at least 44×44 CSS pixels. Both keyboard and click paths were exercised.

Local database checks: zero SMS attempts, notifications, auth users, and deadlocks. The empty root database retained zero salons, users, bookings, and profiles; the task ledger table remained absent there. The RPC gateway recorded no denied unexpected route. Network guards blocked external traffic and unapproved mutation endpoints.

## Failures retained, not erased by a green run

1. Original harness failed before POST because its broad button locator matched both the product button and Next's development-only DevTools button. Its failed summary remains `waitlist-webkit-real-b56-summary.json` (exit 1, zero completed checkpoints). Corrected harness selects only named operational buttons; it does not disable product checks or suppress page errors.
2. Corrected harness initially could not launch WebKit inside the filesystem/process sandbox (native abort during launch, no browser or booking request). It was subsequently run with approved local browser execution permission. This is not a product fix or a silent test retry.
3. Earlier B54 product failure and B55 fixture/title failures remain retained separately. B56 does not retroactively turn them into PASS.

## Exact harness commands and evidence

Working evidence directory: `/private/tmp/nailiq-current-main-combined-iBPOnd`.

```sh
node /private/tmp/nailiq-current-main-combined-iBPOnd/waitlist-claim-ui-b56.mjs --resume
env -i PATH="$PATH" HOME=/Users/huytran TMPDIR=/private/tmp NODE_OPTIONS=--require=/private/tmp/nailiq-masterplan-combined-local-ojeco5/network-guard.cjs node /private/tmp/nailiq-current-main-combined-iBPOnd/waitlist-webkit-real-b56-corrected.mjs
node /private/tmp/nailiq-current-main-combined-iBPOnd/closeout-b56.mjs
git diff --check
```

The interactive scenario commands, target dates, and actual outcome counts are represented by the immutable per-checkpoint JSON and screenshots. Do not replay this `--resume` run blindly: its bounded fixture has already used case 8, and committed test fixtures remain preserved.

Key artifacts: `waitlist-claim-ui-b56-final.json`, `waitlist-webkit-real-b56-corrected-summary.json`, `combined-webkit-database-evidence-b56.json`, and 15 corresponding screenshots. Capability tokens and provider credentials are not included in this report. All owned application/proxy/gateway/browser processes were stopped after testing; the synthetic database evidence was retained.

## Verification boundaries and next gate

No production source changed in B56: only the QA harness and this evidence document were added. B54 source files and B55 QA files are hash-checked against their preserved manifests; all four staged imported files remain staged and unchanged. `git diff --check` passed. Full unit/typecheck/lint/build were not rerun in B56; their earlier B54/B55 results must not be called fresh B56 results.

Still NOT PROVEN: hosted QA/Preview E2E of this unpublished combined candidate, hosted migration ACL/advisors/rollback rehearsal, physical Safari/iPhone, real scheduler/provider delivery, and human pilot acceptance. No commit, push, PR update, hosted migration, deployment, notification, or live-salon change occurred in B56. Publication and hosted database changes require exact scoped approval; do not claim the Master Plan is 100% complete.
