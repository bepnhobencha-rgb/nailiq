import { assertNotProductionFromEnv } from "./guardProduction";

/**
 * Playwright globalTeardown — best-effort in-process sweep.
 *
 * This runs after the last worker exits, including when specs failed or timed
 * out, so it catches far more than `test.afterAll()` ever did. It does NOT
 * survive the process being killed outright (a cancelled CI job), which is why
 * the workflow also runs `scripts/e2e-sweep.ts` in a step marked
 * `if: always()` — that step is the real backstop. Keeping both means a local
 * run cleans up after itself without anyone remembering to invoke the script.
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
  const { sweep } = await import("./sweep");
  await sweep();
}
