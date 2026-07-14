import { assertNotProductionFromEnv } from "./guardProduction";

/**
 * Playwright globalSetup — the first thing that runs, before any worker, any
 * fixture, and any `createClient` call in a spec.
 *
 * Throwing here aborts the entire run, so a misconfigured environment cannot
 * create a single user, salon, staff row, booking, or role grant. Putting the
 * check in individual specs would leave whichever helper ran first free to
 * write before anyone looked.
 */
export default function globalSetup(): void {
  assertNotProductionFromEnv();
}
