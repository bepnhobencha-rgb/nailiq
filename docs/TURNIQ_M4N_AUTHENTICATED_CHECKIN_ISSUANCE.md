# TurnIQ M4N — Authenticated check-in issuance

Status: implemented and tested locally only. Not applied to QA or Production.

## Outcome

- Adds a Server Action for authenticated Owner/Admin/Senior/Receptionist users
  to issue a short-lived appointment QR or a bounded walk-in kiosk QR.
- Requires both the salon TurnIQ flag and explicit platform TurnIQ flag.
- Keeps the raw capability in the URL fragment. The database stores only its
  SHA-256 hash, and the browser never persists the raw capability.
- Adds an irreversible, same-salon, actor-attributed revoke command with
  idempotent retry.
- Adds a front-desk QR manager and a public customer check-in page that submits
  only the PII-free shadow receipt from M4M.
- Refactors the customer card to NailIQ Button/Card primitives and preserves
  the earlier local pure harness.

## Safety boundary

M4N remains Preview/local-only at the action and page boundary. It cannot
create, update, cancel, or confirm a booking; assign a technician; consume a
turn; occupy a resource; collect money; or send an email/SMS/call. A failed or
expired QR explicitly says that no appointment changed.

The capability and receipt tables use forced RLS and have no browser grants.
Only `service_role` may execute issue, revoke, or record RPCs. Each RPC
independently checks salon membership/context. Revocation is one-way so a
stolen or retired QR cannot be silently reopened.

## Local evidence

- Targeted Vitest: action authorization, fragment-only bearer, kiosk bounds,
  public/manager non-effects, RPC ACL and irrevocable revoke.
- PostgreSQL 17: every local migration applied from zero; SQL fixture proved
  issue, cross-tenant revoke rejection, first revoke, replayed revoke, blocked
  intake after revoke, irreversible revoke and RPC ACL.
- Browser story: pure scenarios remain available; the capability scenario
  proves exact command/submission retry and shadow-only success with an
  intercepted local endpoint.

## Rollback

Keep the platform and salon flags OFF and stop issuing capabilities. Existing
capabilities can be revoked without deleting receipt evidence. Do not drop the
append-only receipt ledger during an incident.

## Next safe milestone

M4O may add expiry/revocation UX hardening, a signed QR print view, accessibility
checks, and disposable-QA verification. It must remain shadow-only until a
separate approved milestone defines how a verified check-in can become a
supervised operational command.
