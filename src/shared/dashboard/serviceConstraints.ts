/**
 * Plain constants for the services setup surface, shared by the
 * server actions in `setupActions.ts` and the client form in
 * `ServicesSetupPanel.tsx`.
 *
 * Originally `SERVICE_DESCRIPTION_MAX_LEN` lived in `setupActions.ts`,
 * but that module carries `"use server"` and Next.js's compiler only
 * allows async function exports from such modules. Re-exporting a
 * non-async const broke the whole module (the build fails with
 * "The module has no exports at all"). Lives here instead.
 */

/** Owner-facing length cap on `services.description`. Enforced in the
 *  app (not in the DB) so copy guidance can change without a migration.
 *  Kept in sync with `userMessages.serviceForm.descriptionTooLong`.
 *
 *  P2.4 — raised from 100 → 250 chars based on QA report; some salons
 *  want to add finish/duration/allergen detail beyond what fits in
 *  100. UI counter and the descriptionTooLong copy update alongside. */
export const SERVICE_DESCRIPTION_MAX_LEN = 250;
