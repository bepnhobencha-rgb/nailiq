# Nail Try-On MVP — Risk Register

| Risk | Severity | Control | Release evidence |
| --- | --- | --- | --- |
| Cross-salon image exposure | Critical | Private bucket, server mediation, RLS, signed URLs | Negative isolation tests |
| Public token leakage | Critical | Store only hash, HttpOnly cookie, no token logs/URLs | Security test and log review |
| AI changes fingers/skin/jewelry | High | Preservation prompt, automated checks, human eval set | 50-image evaluation report |
| Customer mistakes preview for guarantee | High | Persistent disclaimer and booking snapshot | UX/E2E copy assertion |
| Unbounded model cost | High | Idempotency, quotas, rate limits, circuit breaker | Load/double-submit tests |
| Images retained too long | High | `expires_at`, deletion job, retry ledger | Storage deletion integration test |
| Invalid image decoder payload | High | Magic-byte validation, decode limits, normalization | Fuzz/fixture tests |
| Medical inference | High | Explicit non-medical classifier contract and copy | Prompt/schema review |
| Catalog design is not deliverable | Medium | Link design to active service/add-on | Catalog validation tests |
| Slow generation causes abandonment | Medium | Async job, progress state, retryable failure | p50/p95 pilot telemetry |
| Camera permission denied | Medium | File-upload fallback | Mobile E2E |
| Model/provider drift | Medium | Adapter, model telemetry, pinned evaluated snapshot | Eval gate per model change |

## Stop-ship conditions

- any cross-tenant/session access;
- deletion leaves readable storage objects;
- double-submit can create two paid generations;
- no visible AI-preview disclaimer;
- malformed image reaches the model provider;
- quality gate sends rejected images to generation;
- pilot quota can be bypassed from the browser.

