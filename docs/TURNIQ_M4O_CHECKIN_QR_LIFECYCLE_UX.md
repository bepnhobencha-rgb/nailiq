# TurnIQ M4O — Check-in QR lifecycle UX

Status: implemented and tested locally only. Not applied to disposable QA,
Preview, or Production.

## Outcome

- Makes the active QR lifecycle obvious to front-desk staff with a visible
  expiry countdown, explicit expired state, and irreversible revoke feedback.
- Prevents an active QR from being silently orphaned by changing the QR type
  or appointment. Staff must revoke it first; an expired QR may be replaced.
- Adds a bilingual print view that contains the salon name, scan instruction,
  and a truthful statement that check-in records arrival for staff review but
  does not create or change an appointment.
- Blocks copy and print after client-observed expiry while retaining Revoke.
  Server expiry remains authoritative even if a device clock is wrong.
- Adds English/Vietnamese customer guidance, distinct expired/rate-limit/server/
  network errors, live browser online/offline detection, and focus movement to
  the latest error or successful receipt.
- Keeps the command ID and submission time stable across safe retries.

## Safety boundary

M4O changes presentation and local browser coverage only. It does not add a
database migration or a new mutation path. The QR continues to submit the
M4M append-only PII-free shadow receipt and cannot create, update, cancel, or
confirm a booking; assign a technician; consume a turn; occupy a resource;
collect money; or send email, SMS, or calls.

The raw capability remains URL-fragment-only and is not printed as text or
persisted in browser storage. Revocation and expiry are enforced by the server,
not trusted to the countdown.

## Local evidence

- Targeted Vitest: 6 files and 30 tests pass for pure intake, Server Action,
  route, service-role boundary, ACL, idempotency, and non-mutation safeguards.
- TypeScript and focused ESLint pass.
- Playwright desktop Chrome and iPhone-size WebKit cover create, countdown,
  print request, active-link replacement guard, revoke, expiry, live offline
  recovery, exact retry, bilingual errors, and shadow-only success.
- Automated WCAG A/AA checks pass on both customer check-in and active QR
  manager surfaces at desktop and mobile sizes.

## Rollback

Keep platform and salon TurnIQ flags OFF. Revert the M4O presentation files if
needed; no data rollback exists because this milestone adds no schema or live
state. Previously issued capabilities remain governed by M4M/M4N server expiry
and revoke behavior.

## Next safe milestone

M4P may apply the existing M4M migration to an explicitly approved disposable
QA project, configure an approved Preview, and repeat tenant/ACL/browser tests.
It must not enable a live salon or turn a shadow receipt into a booking or
assignment without a separate approved operational design.
