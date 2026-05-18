import { test as base } from "@playwright/test";
import { cleanupTestSalon } from "../helpers/db";
import {
  seedReceptionistCenterFixture,
  RECEPTIONIST_E2E_SLUG,
  type ReceptionistCenterFixture,
} from "./helpers";

type WorkerFixtures = { rcFixture: ReceptionistCenterFixture };

// Worker-scoped fixture: seeds the shared RC salon once per shard (workers=1 in CI),
// then cleans up at worker teardown. Saves ~15 redundant seed+cleanup cycles.
export const test = base.extend<{}, WorkerFixtures>({
  rcFixture: [
    async ({}, use) => {
      const fx = await seedReceptionistCenterFixture();
      await use(fx);
      await cleanupTestSalon(RECEPTIONIST_E2E_SLUG);
    },
    { scope: "worker" },
  ],
});

export { expect, type Page } from "@playwright/test";
