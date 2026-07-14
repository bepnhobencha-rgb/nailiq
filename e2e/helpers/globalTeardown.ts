import { assertNotProductionFromEnv } from "./guardProduction";
import { sweep } from "./sweep";

/**
 * Playwright globalTeardown — best-effort in-process sweep.
 *
 * This runs after the last worker exits, including when specs failed or timed
 * out, so it catches far more than `test.afterAll()` ever did. It does NOT
 * survive the process being killed outright (a cancelled CI job), which is why
 * the workflow also runs `scripts/e2e-sweep.ts` in a step marked
 * `if: always()` — that step is the real backstop. Keeping both means a local
 * run cleans up after itself without anyone remembering to invoke the script.
 *
 * `sweep` is imported STATICALLY. It used to be `await import("./sweep")`, on the
 * theory that the guard should speak before the module loaded — and that threw
 * `SyntaxError: Cannot use import statement outside a module` on every single
 * run, turning a fully green suite red with "1 error was not a part of any test".
 * The theory was wrong anyway: sweep.ts calls assertNotProductionFromEnv() inside
 * sweep(), not at module load, so the static import guards nothing less.
 *
 * Note what that bug quietly proved: this teardown had been failing on every run
 * so far, and nothing leaked — because the workflow's always-run sweep step did
 * the work. The belt-and-braces was not paranoia.
 */
export default async function globalTeardown(): Promise<void> {
  try {
    assertNotProductionFromEnv();
  } catch {
    // If the guard trips here the run never seeded anything. Nothing to do.
    return;
  }
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  ) {
    return; // db-free run
  }
  await sweep();
}
