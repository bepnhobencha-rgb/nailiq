# P1-03 — V1 flows, EN/VI and device matrix (2026-09-15)

## Scope and evidence class

- Isolated branch: `audit/p1-03-ux-20260915`
- Base SHA: `85af2dc2bbae8f4fe842930dea7fef75cae0c3b6`
- Environment: local Next.js against disposable local Supabase with synthetic data.
- SMS, email, calls, provider notifications and payment charge dispatch: disabled.
- Square Production, live customers, live bookings and Production writes: none.
- Publication status: commit `d66043b2`, PR #1409 and Vercel QA Preview;
  no merge or Production deployment.

## Existing before this task

- The base suite already covered desktop/mobile Receptionist Center, responsive
  drawers, queue actions, booking edits, cancellation, dashboard navigation,
  touch target sizes, text sizes and WCAG color contrast.
- The existing operator journey covered five Front Desk tasks on Chromium and
  iPhone 14 WebKit, but did not select EN/VI explicitly or run the required
  iPhone SE, iPhone Pro Max and iPad matrix.
- There was no dedicated P1-03 Playwright configuration or attached end-state
  screenshot for every required language/device combination.

## Defects found and fixed locally

### WebKit walk-in fields rendered below the 44px contract

The `Source` and `Priority` native selects in `WalkinAddForm` used only
`min-h-11`. WebKit rendered `walkin-source` at 25px on the iPhone viewport,
while Chromium rendered it at the intended size. Both selects now use an
explicit `h-11 min-h-11`, matching the existing requested-staff field.

### Vietnamese review displayed an English date

The public individual-booking review always formatted the selected date with
`en-US`, even when the rest of the flow was Vietnamese. Computer Use reproduced
the mixed string `Tue, Sep 15, 2026 · 4:00 PM UTC`. The formatter now receives
the booking language and uses `vi-VN` or `en-US`; the Vietnamese review renders
`Thứ 3, 15 thg 9, 2026 · 4:00 PM UTC`, while switching to English restores the
English date without losing the selected service, staff, date, time or guest
details.

### Multi-language journey contained English-only close locators

Two journey steps looked only for `Close`. They now accept the product's
English `Close` and Vietnamese `Đóng` labels.

### Future-date reload could accept the old route in WebKit

The journey was already on `/center` when it requested
`/center?date=YYYY-MM-DD`. Under an in-flight RSC refresh, the helper's route
wait could resolve against the old URL before the dated navigation committed.
The synthetic booking existed durably, but the page stayed on today and could
not render tomorrow's booking. The journey now performs a clean full navigation
and asserts the exact `date` query before touching that booking.

The journey also handles the queue panel according to rendered state. It closes
an open today panel before working with the schedule and treats the panel's
absence on a future date as the expected state.

## Device and language matrix

| Project | Browser/device profile | Language | Full five-task journey | Final UI evidence |
|---|---|---|---|---|
| `desktop-en` | Desktop Chrome | EN | PASS | Attached |
| `iphone-se-en` | iPhone SE WebKit | EN | PASS | Attached |
| `iphone-pro-max-vi` | iPhone 14 Pro Max WebKit | VI | PASS | Attached |
| `ipad-vi` | iPad Pro 11 WebKit | VI | PASS | Attached |

Each journey proves synthetic appointment creation, same-salon customer lookup,
four walk-in creations, explicit busy state, waitlist visibility, appointment
status transition and database persistence. It disables appointment
notifications before submission and does not press provider-backed invite or
payment actions.

## Verification

| Gate | Result |
|---|---|
| WebKit 44px regression | PASS — the former 25px source select and the priority/request fields meet the contract |
| Full mobile-layout suite | PASS — 18/18 |
| P1-03 EN/VI device matrix | PASS — 4/4 |
| iPhone Pro Max VI + iPad VI repeat/race run | PASS — 4/4 across two repeats |
| Dashboard, drawer, edit, cancel and queue suite | PASS — 59 passed, 1 device-conditional skip, 0 failed |
| Booking role matrix | PASS — 10/10 across Owner, Admin, Senior, Receptionist and Nail Tech denial |
| Touch target and text-size contract | PASS — primary controls at least 44px and form text at least 16px |
| Mobile day-view WCAG color contrast | PASS — zero Axe color-contrast violations in the covered surface |
| Confirm-date locale unit regression | PASS — 2/2 for EN and VI |
| Computer Use public-booking journey | PASS — synthetic VI flow reached review without submitting; VI date fixed, EN toggle correct and form state preserved |
| Data persistence | PASS — UI writes were read back from disposable QA Postgres |
| Touched-file ESLint | PASS — 0 errors; 3 unchanged pre-existing warnings in `useBookingFlowState.ts` |
| TypeScript `tsc --noEmit` | PASS |
| Next production build | PASS |
| Playwright HTML report | PASS — four end-state screenshots stored under `playwright-report/` locally |

## QA Preview verification

- Deployment: `dpl_FHUqwpnwGoUX8JTuJBpTTL4MMJXj`
- URL: `https://nailiq-git-audit-p1-03-ux-20260915-bepnhobencha-2588s-projects.vercel.app`
- Vercel target/state: Preview / READY.
- Computer Use loaded the public Hi-Lite Studio booking entry in Vietnamese,
  confirmed the EN/VI controls changed the rendered copy, and found no browser
  console errors.
- No guest data was entered and no booking, notification, provider or payment
  action was submitted during Preview verification.

The test runner emitted known development-only messages for closed RSC streams,
unauthenticated server probes and multiple local Supabase browser clients. They
did not fail a gate, alter the persisted assertions or trigger outbound work.

## Acceptance status

| P1-03 condition | Status | Evidence or remaining work |
|---|---|---|
| No covered buttons | QA PASS | Drawer and primary-action viewport tests passed on desktop/mobile; iPad setup controls stayed above bottom navigation. |
| No horizontal overflow | QA PASS | Mobile layout containment tests passed. |
| No data loss | QA PASS | Appointment, walk-in and status transitions were read back from QA Postgres. |
| Consistent covered state labels/colors | QA PASS | EN/VI state pills, schedule blocks, alerts and success states rendered in the matrix; covered mobile contrast passed. |
| Public-booking EN/VI review | QA PASS | Computer Use verified the corrected VI date and state-preserving switch back to EN. |
| Correct role access | QA PASS | Ten desktop/mobile role cases passed. |
| New user creates appointment in under 60 seconds | NOT PROVEN | Automated runtime is below the ceiling, but it is not a moderated first-time human pilot. |
| New user creates walk-in in under 30 seconds | NOT PROVEN | Requires a timed pilot with a new receptionist/owner. |
| Physical iPhone/iPad | NOT PROVEN | Current evidence uses real Chromium/WebKit engines with device profiles, not physical hardware. |
| Preview verification | QA PASS | Deployment READY; public VI booking entry loaded in Computer Use with no console errors. |

## Rollback boundary

- Revert the explicit `h-11` additions in `WalkinAddForm.tsx` to restore the
  previous select sizing.
- Remove `playwright.p1-03-ux.config.ts` and revert the operator-journey
  language, navigation and screenshot changes to remove the new acceptance
  harness.
- Revert the language argument in `useBookingFlowState.ts`, the locale-aware
  formatter in `bookingConfirmLabels.ts` and its focused test to restore the
  previous confirmation-date behavior.
- No database rollback is needed; this task adds no migration and changes no
  durable schema.

## Verdict

- Product defect found and fixed locally: **PASS**
- Local automated P1-03 code/QA acceptance: **PASS**
- Preview verification: **QA PASS**
- Physical-device and first-time-user timing acceptance: **NOT PROVEN**
- Production deployment/verification: **NOT RUN**
- P1-03 final operational closure: **NOT YET COMPLETE**
