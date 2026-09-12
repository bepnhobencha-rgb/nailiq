# Remote QA Certification

Remote QA Certification lets NailIQ run its release-critical browser journeys
without depending on Huy's Mac, Chrome session, or a long-lived test database.

## Safety boundary

- The workflow checks out one exact 40-character commit SHA.
- It starts Supabase Local inside the GitHub runner and destroys it with
  `supabase stop --no-backup`, even after a failing test.
- The database guard runs before the baseline or fixture seed.
- SMS, email, calls, payment dispatch, provider reads, pairing, webhooks and
  workers are disabled. Provider credentials are empty.
- The workflow has read-only repository permission and receives no Production
  secrets.
- Playwright evidence is retained for 14 days; no customer data is present.

## What the release-critical run covers

- Public booking smoke and committed booking read-back.
- Booking conflict, group happy path and seat-together behavior.
- Waitlist, no-show/waitlist and timezone-sensitive rescheduling.
- Receptionist five-task operator journey.
- TurnIQ check-in, customer check-in, rush-hour comprehension, staff PIN,
  supervised staggering, retry and offline truth.
- Mobile receptionist, group booking and TurnIQ rush-hour journeys in WebKit.

## Running it

After this workflow is merged to the default branch, dispatch **Remote QA
Certification** with the exact candidate commit SHA. A pull request that changes
this workflow also runs the same certification automatically.

The GitHub run summary is the verdict. Download the `remote-qa-<sha>` artifact
for screenshots, traces, HTML reports and the application server log. A green
run is QA evidence for the exact source commit; it is not Production or salon
pilot proof.
