# Nail Try-On MVP — Pull Request Checklist

## Every PR

- [ ] Scope matches one delivery slice in `SPEC.md`.
- [ ] Feature remains OFF by default.
- [ ] No secret, service-role key, signed URL, token, or image bytes in logs.
- [ ] Boundary inputs have runtime validation.
- [ ] EN/VI copy stays in the i18n system.
- [ ] Touch targets and accessibility checks meet NailIQ governance.
- [ ] Typecheck, lint, unit, relevant integration/E2E, security and build pass.
- [ ] Rollback is described in the PR.

## Database/Storage PR

- [ ] Migration created through the repository's imperative workflow.
- [ ] RLS enabled on every exposed table.
- [ ] Policies include ownership/membership predicates, not role-only access.
- [ ] Private bucket has no anonymous direct read/write policy.
- [ ] Cross-salon and cross-session negative tests exist.
- [ ] Storage deletion is verified, including partial-failure retry.
- [ ] Advisors reviewed.

## AI generation PR

- [ ] Provider request is server-side.
- [ ] Idempotency prevents duplicate paid calls.
- [ ] Model name is centralized and recorded per job.
- [ ] Retry policy excludes customer/policy/quality failures.
- [ ] Cost, latency, outcome and request ID are observable without PII.
- [ ] Golden-image evaluation passes before rollout.

## Release PR

- [ ] Pilot salon flag explicitly enabled.
- [ ] Quota and circuit breaker configured.
- [ ] Consent, disclaimer, retention and deletion copy approved.
- [ ] Support/rollback runbook tested.
- [ ] No automatic rollout to all salons.

