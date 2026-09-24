# Local stream-abort attribution (diagnostic, not a product fix)

No app code, original error logging, provider configuration, or assertions are
changed. Do not run alongside another server using port 3117. This config must
run through the existing local-only runner and its disposable DB safety checks.

```sh
node --test qa/day5/stream-abort-reproduction.cjs qa/day5/stream-request-correlation.test.cjs
node qa/day5/run-local.mjs test --config qa/day5/stream-diagnostic.config.ts --project=mobile-en e2e/receptionist-center/operator-journey.spec.ts
```

The final `--config` selects the diagnostic config, retaining the same real UI
journey. It adds a preload on the QA Next server and separate
`test-results/day5-stream-diagnostic` artifacts/JSON so it cannot overwrite the
six-project `day5-operator` matrix report. No
environment secrets are inherited into the runner from the invoking shell.

The preload adds `[qa-stream]` JSON records with process/request ID, time,
allowlisted method, redacted route category, response status and lifecycle.
It never logs request headers, body, cookies, query strings, email or salon slug.
Original `console.error` calls are always forwarded unchanged. It refuses to
initialize unless local disposable Supabase and outbound suppression match.
Extra diagnostic records for `/_next/` assets are omitted to limit noise;
original errors for those requests are still forwarded without alteration.

## Evidence interpretation

- `stream-error` with a non-null request ID links the actual React/Next warning
  to that request's async context; numeric digest is included when available.
- The **same ID** must have `response-close` with `writableFinished: false`
  (no preceding successful `response-finish`) to establish incomplete HTTP
  delivery. A normal completed response also emits `close`; that alone is not
  an abort.
- `/register` or `/register/setup` plus the observed real sign-in/full-navigation
  sequence narrows that reproduction to the auth navigation. The source uses
  `window.location.assign('/register/setup')` after password auth, followed by
  a role-specific server redirect. This is a hypothesis until the request IDs
  and lifecycle evidence match on an actual run.
- A null ID, a finished response, or a different route leaves the specific
  auth-abort hypothesis **NOT PROVEN**; do not classify it from timing alone.
- Neither a passing UI test nor this reproduced cause explains every historical
  `1483451839` occurrence. Do not globally suppress the message or digest.

The focused HTTP test opens only one ephemeral loopback port. It renders a real
suspended React response, deliberately disconnects its local client, and proves
the original React warning and unfinished HTTP response share one request ID.
The separate React control proves a completed render has no warning.
