# Resend shared-account QA boundary (2026-09-22)

## Status

Code only. The QA Resend webhook stays disabled. No real email or provider calls are part of this verification.

Resend webhooks on the existing shared account are account-wide for subscribed event types. The filter below runs **after an HTTP payload reaches NailIQ**, so it prevents unrelated events from being persisted to QA, but does **not** prevent a Live salon event payload from being delivered transiently to an enabled QA endpoint. Do not call this full transport isolation. An isolated Resend account is required for that stronger guarantee.

## Boundaries

- `DISABLE_OUTBOUND_EMAIL=1` suppresses a promoted-waitlist email before Resend, and records a durable `outbound_email_disabled` result. SMS retains its separate control.
- QA-only webhook mode requires `NAILIQ_RESEND_QA_WEBHOOK_ONLY=1`, `VERCEL_ENV=preview`, `NAILIQ_DISPOSABLE_DB=1`, a pinned `NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF`, both Supabase URLs matching that ref, and one `NAILIQ_QA_RESEND_EMAIL_RECIPIENT`. Missing or mismatched configuration fails closed. Never set these QA-only variables in Production.
- In QA mode, only a signed Resend event tagged `nailiq_env=qa` and `nailiq_qa_ref=<pinned project ref>` for that one recipient can reach the existing event parsers/database. Other signed events are acknowledged but ignored before database access.
- In normal mode, QA-marked events are ignored before database access. Signature verification always precedes filtering.
- The promoted-waitlist sender attaches the same two QA tags only when QA mode and the recipient pin validate. If QA mode is invalid, the email is suppressed before Resend. Existing normal-mode payload fingerprints remain unchanged.

## Activation boundary

Do not enable the QA webhook, set up a real QA send, or turn off kill switches as part of this PR. A later, separately authorized rehearsal must verify the exact QA deployment SHA, its project/recipient pins, the disabled state of all outbound providers, and whether shared-account transport exposure is acceptable to the owner. Production webhook and Live salon settings are not part of this change.
