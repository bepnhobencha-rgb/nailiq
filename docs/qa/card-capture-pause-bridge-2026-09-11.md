# Schema-compatible card capture pause bridge

This local artifact is based on Production SHA `15fe1091fd71eda4a67704d08e5ab535967e5904`. It is a separate transition build from the receipt-truth candidate in PR1397. No schema change, commit, push, PR or Production deployment has been performed for this bridge.

Setting `NAILIQ_CARD_SAVE_DISPATCH_DISABLED=true` in a newly deployed bridge process rejects card capture before database claims or provider mutations. The same shared guard covers capability save/Stripe setup, legacy save/reuse/auto-attach, Square/Stripe save adapters, and the low-level Square CreateCard function. The flag must be exactly `true`; no payment/refund/remove behavior is added. The guards require no new database columns or functions.

Validation: 14 focused tests prove zero database/provider calls when paused; webpack Next build, subsequent standalone typecheck and touched-file lint passed. The complete clean-environment unit suite now passes 4749 tests with one opt-in skip and zero failed tests or suites. Four Square client suites mock only the server marker. One old source-boundary assertion depended on a 9000-character distance; it now verifies claim replay mapping and the early reconciliation return within the save function, backed by the existing executable no-redispatch test. No safety assertion or provider guard was removed. These are local results. A deployed pause has not been verified.

Before any Production schema migration, the release operator must establish all of the following under a separate explicit approval:

1. The correct bridge build is deployed with capture paused. Merely changing an environment variable on the old build is ineffective because old code/processes do not implement/read the guard.
2. Old in-flight writers have settled, and stale deployment URLs/origins cannot accept new unguarded card writes during the migration window. Moving the primary alias alone is not proof of this condition. If this cannot be demonstrated, do not begin the database upgrade; choose a separately approved maintenance/gating method.
3. Production function-body parity is checked, including the missing terminal-continuation migration. Do not infer parity from migration-row counts or blindly replay unrelated migration differences.
4. Apply the approved receipt migrations, deploy the receipt-aware candidate while paused, verify the reservation/protection distinction, then make the separate unpause decision. No automatic cancellation, provider charge or customer outreach is part of this bridge.

Rollback before the receipt schema upgrade requires only reverting the bridge application/environment; no database rollback is involved. After the schema upgrade, use a receipt-aware rollback target and retain provider receipts and diagnostic history. An old-schema/application rollback then requires a separately rehearsed compatibility or restore plan. The bridge itself is not evidence of zero downtime or a drained Production provider queue.

The prepared branch name is `fix/card-capture-pause-bridge-20260911`. Its exact branch is disabled for automatic Vercel deployments in `vercel.json`; cron configuration is unchanged. If publishing this separate bridge is approved, create and verify QA-only environment overrides (including capture paused, outbound off and charge dispatch off) before explicitly creating any Preview. The current project-wide Preview defaults must not be used for this branch. No branch, remote environment or Preview has been created for this bridge.
