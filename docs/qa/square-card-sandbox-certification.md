# Square card delivery — Sandbox certification

This suite is opt-in. On 2026-09-11, its seven new-run scenarios **passed against actual Square Sandbox** with disposable PostgreSQL after Huy explicitly authorized incidental test email/SMS. A separate exact-operation recovery-only run passed with one card read and zero provider mutations. See the main delivery-truth QA report section 12 and `sandbox-backend-run3.json` / `sandbox-backend-recovery1.json` in the task evidence directory. Each mode skips the scenarios belonging to the other mode; a skipped test is never a pass. The earlier PostgreSQL integration suite uses simulated Square transport and remains a separate evidence class.

## Required environment

Use an existing dedicated Square Sandbox application/account. Provider notifications must be OFF by default. Before running in the default `off_required` mode, record separate endpoint-specific evidence of the account's notification settings and attest to that evidence with `NAILIQ_QA_SQUARE_NOTIFICATIONS_OFF_VERIFIED=1`. This flag is an operator attestation, not an automatic Square suppression check. The guard refuses the default mode when the attestation is absent; an empty webhook list alone is insufficient evidence.

Huy explicitly authorized possible email/SMS notifications from this Sandbox card test on 2026-09-11. For this authorized run only, set `NAILIQ_QA_SQUARE_NOTIFICATION_MODE=test_notifications_authorized` and leave the OFF-evidence flag unset. Record the authorization and selected mode in the run evidence. This mode accepts incidental provider notifications; it does **not** assert or change Square suppression settings and does not enable NailIQ SMS/email/calls. Never use it without explicit authorization. Synthetic contacts, the dedicated Sandbox account, no real cards, and all other boundaries still apply.

Both modes require no enabled webhook subscriptions. The guard checks the seller token's application and merchant, an active CAD location, and every webhook subscription page. It fails closed when webhook suppression cannot be proved, does not alter subscriptions, and does not treat authorization for incidental email/SMS as permission for webhook delivery.

Custom Sandbox test accounts use OAuth tokens. The [Webhook Subscriptions API](https://developer.squareup.com/docs/webhooks/webhook-subscriptions-api) requires the application's personal token, so provide that existing Sandbox token separately when testing a custom account. The guard verifies both tokens against the same Sandbox application; the personal token may belong to the default test account. It is used only for token-status and subscription reads. Customer/card requests continue to require the selected seller's token. No token issuance, permission expansion, webhook mutation or notification test is part of this suite.

Load secrets privately into the test process; never paste them into chat, save them in this repository, or load `.env.local`.

| Variable | Required value |
| --- | --- |
| `NAILIQ_CARD_SANDBOX_QA` | `1` |
| `NAILIQ_QA_SQUARE_ENVIRONMENT` | `sandbox` |
| `NAILIQ_QA_SQUARE_NOTIFICATION_MODE` | Omitted or `off_required` by default; `test_notifications_authorized` only for an explicitly authorized test run |
| `NAILIQ_QA_SQUARE_NOTIFICATIONS_OFF_VERIFIED` | `1` only with separately recorded suppression evidence in `off_required` mode; leave unset for `test_notifications_authorized` |
| `NAILIQ_QA_SQUARE_SANDBOX_APPLICATION_ID` | Verified Sandbox application |
| `NAILIQ_QA_SQUARE_SANDBOX_MERCHANT_ID` | Matching Sandbox merchant |
| `NAILIQ_QA_SQUARE_SANDBOX_LOCATION_ID` | Active CAD Sandbox location |
| `NAILIQ_QA_SQUARE_SANDBOX_ACCESS_TOKEN` | Existing Sandbox token for the selected seller and CAD location |
| `NAILIQ_QA_SQUARE_SANDBOX_WEBHOOK_ACCESS_TOKEN` | Existing personal Sandbox token for the same application; required when the seller token is OAuth. If omitted, the seller token must itself support webhook reads. An explicitly empty value fails configuration. |
| `NEXT_PUBLIC_SUPABASE_URL` | `http://127.0.0.1:55631` |
| `DB_URL` | Disposable PostgreSQL, `127.0.0.1:55632/postgres`, postgres user, no URL query parameters |
| `SUPABASE_SERVICE_ROLE_KEY` | Disposable local service key |
| `DISABLE_OUTBOUND_SMS`, `DISABLE_OUTBOUND_EMAIL`, `DISABLE_OUTBOUND_CALLS` | All `1` |
| `NAILIQ_CARD_SANDBOX_JOURNAL` | New absolute `.jsonl` path outside the repository |
| `NAILIQ_CARD_SANDBOX_RECOVER_OPERATION_ID` | Optional exact existing operation UUID from an interrupted journal; enables the recovery-only case and skips all new booking/customer/card test cases |

The complete task migration must be installed on this disposable database. Cron/Edge Functions and NailIQ outbound SMS/email/calls remain OFF in both modes. Square's incidental customer/merchant notification behavior is reported separately as proven OFF or explicitly accepted but unproven. The suite inserts synthetic salon/service/staff/bookings locally and creates only synthetic customers and cards in Sandbox. Payment, refund and messaging routes are blocked. There is a 24-write provider ceiling per run.

Synthetic customer email identities use only `synthetic-<unique-id>@example.com`, with a strict prefix and the exact reserved example domain. A read-only Sandbox probe rejected the earlier `example.test` fixture with HTTP 400 `INVALID_VALUE` on the email field before any customer/card mutation. This fixture compatibility correction is test-only and is not evidence of the Production incident's root cause. The guard rejects arbitrary contacts, subdomains and domain suffix lookalikes on both customer search and creation paths.

## Run and interruption handling

After private environment setup, run only this suite, with one worker and stop on first failure:

```sh
node node_modules/vitest/vitest.mjs run src/shared/booking/__tests__/cardDeliveryTruth.sandbox.qa.spec.ts --maxWorkers=1 --bail=1
```

The journal is opened exclusively with mode 0600. Reusing its filename fails before a provider call. Preserve the journal and disposable database after an interrupted or ambiguous run. Inspect the recorded booking/operation and reconcile using its original reference before deliberately starting another run. Do not delete the journal or reset that database merely to rerun a failed test. No automatic cleanup mutation is sent to Square.

For an interrupted unknown operation, set `NAILIQ_CARD_SANDBOX_RECOVER_OPERATION_ID` to its exact journal UUID and use a new recovery journal. This path validates the operation's synthetic tenant and Sandbox merchant/environment, performs only exact-reference provider card reads, and does not seed fixtures or invoke save-card logic. Its transport rejects provider mutations; successful recovery is followed by an idempotent second check with no additional provider read. Remove the variable deliberately before running new scenarios.

Reconciliation scenarios wait for the real two-minute dispatch window, active lease, schedule and recent-read cooldown to expire, using read-only local checks at most every five seconds. The helper never backdates dispatch timestamps or clears leases/schedules. The wait is capped at 150 seconds and these cases have a 180-second test timeout; an incomplete safety window fails the case without a provider call. The initial real response-loss test claimed too early and returned `reconciliation_wait` with zero provider reads, which was a harness timing error, not proof that Square could not reconcile the card.

The seven scenarios cover successful save, duplicate requests, a Sandbox decline, timeout before mutation, response loss after CreateCard, database response loss before/after commit, and concurrent bookings sharing one customer identity. Injected faults are labelled simulations around actual provider requests, not outages caused at Square.

## Evidence boundaries

This backend suite uses Square's fixed `cnon:card-nonce-ok` and `cnon:card-nonce-declined` fixtures. The test transport adds postal code `94103`, required by the fixed nonce fixture; production code is unchanged. See [Square Sandbox testing](https://developer.squareup.com/docs/devtools/sandbox/testing) and [CreateCard](https://developer.squareup.com/reference/square/cards-api/create-card).

A passing backend suite still does not prove Web Payments SDK tokenization, hosted iframe behavior, or the full browser flow. Those require a separate real-browser run with synthetic Sandbox card entry and the same isolated database. Preview publication/verification also remains separate and requires Huy's explicit authorization.

Record the notification mode and its evidence/authorization, exact counts, operation outcomes, first failure stages, provider call counts and safe journal/evidence paths. Report `test_notifications_authorized` as acceptance of possible notifications, never as notifications suppressed or OFF verified. Never include source tokens, full request/response bodies, credentials or card details in the report.

## Computer Use checkpoint — 2026-09-11

Chrome loaded the real Sandbox Web Payments SDK 1.84.5 on localhost and tokenized synthetic card entry after fixing the recovery request's missing billingContact object. The local server then deliberately blocked the customer-search fetch before network; the resulting operation was failed/customer_search, with consent retained and booking retry_required. Reload/new-form/unknown/manual/saved-fixture UI checks passed. This proves the SDK-to-local-route segment only, not successful CreateCard, provider decline, response-loss reconciliation or the prepared seven-case backend suite. The server contained only dummy Square backend credentials. See the main QA report section 11 and cua-ui-results.json.

HTTP 127.0.0.1 produced WebSdkEmbedError because the current SDK requires HTTPS except localhost; Chrome's localhost route needed an IPv6 loopback listener. No certificate/security bypass was used. Keep real card data out of Sandbox and evidence.
