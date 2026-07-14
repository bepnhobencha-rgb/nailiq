/**
 * Standalone E2E sweep — invoked from the workflow with `if: always()`.
 *
 * Cleanup used to live only in `test.afterAll()`. The E2E workflow sets
 * `concurrency: cancel-in-progress: true`, so a newer push kills the running
 * job mid-flight and `afterAll` never fires. That is exactly how five
 * `*.test.invalid` auth users (two of them active `founder` superadmins) and
 * three `e2e-*` salons ended up living in the production database — see
 * docs/audit/E2E-PRODUCTION-CONTAINMENT.md.
 *
 * A workflow step survives cancellation where an in-process hook does not, so
 * this is the real backstop. It refuses to run against production, only
 * touches marker-scoped rows, and is idempotent.
 *
 * Usage: npx tsx scripts/e2e-sweep.ts
 */
import { sweep } from "../e2e/helpers/sweep";

sweep()
  .then(({ users, salons }) => {
    console.log(
      `[e2e-sweep] done — removed ${users} auth user(s), ${salons} salon(s)`,
    );
  })
  .catch((err: unknown) => {
    console.error(
      "[e2e-sweep] failed:",
      err instanceof Error ? err.message : err,
    );
    // Never fail the job on a sweep problem — the tests' own verdict is what
    // gates the merge. A missed sweep is visible in the log and caught by the
    // next run's setup.
    process.exit(0);
  });
