import { expect, test } from "@playwright/test";

import {
  cleanupTestSalon,
  cleanupTestUser,
  controlTestOperationalException,
  getOperationalExceptionState,
  seedOperationalException,
  seedTestSalon,
  seedTestUser,
} from "./helpers/db";

test.describe("AI operational exception lifecycle", () => {
  let testSlug = "";
  let userId = "";

  test.afterEach(async () => {
    if (testSlug) await cleanupTestSalon(testSlug);
    if (userId) await cleanupTestUser(userId);
  });

  test("is atomic, idempotent, salon-scoped, and append-only audited", async () => {
    const salon = await seedTestSalon({
      slug: `e2e-ai-exception-${test.info().workerIndex}`,
      name: "E2E AI Exception Salon",
    });
    testSlug = salon.slug;
    const user = await seedTestUser({
      email: `ai-exception-${Date.now()}-${test.info().workerIndex}@example.test`,
    });
    userId = user.userId;
    const seeded = await seedOperationalException(salon.salonId);
    expect(seeded.status).toBe("open");

    const acknowledged = await controlTestOperationalException({
      salonId: salon.salonId,
      alertId: seeded.alertId,
      operation: "acknowledge",
      actorUserId: user.userId,
    });
    expect(acknowledged).toEqual({
      outcome: "updated",
      alert_status: "acknowledged",
    });

    const replay = await controlTestOperationalException({
      salonId: salon.salonId,
      alertId: seeded.alertId,
      operation: "acknowledge",
      actorUserId: user.userId,
    });
    expect(replay).toEqual({
      outcome: "unchanged",
      alert_status: "acknowledged",
    });

    const resolved = await controlTestOperationalException({
      salonId: salon.salonId,
      alertId: seeded.alertId,
      operation: "resolve",
      actorUserId: user.userId,
      resolutionNote: "Reviewed staffing coverage and restored capacity.",
    });
    expect(resolved).toEqual({
      outcome: "updated",
      alert_status: "resolved",
    });

    const wrongSalon = await seedTestSalon({
      slug: `${testSlug}-other`,
      name: "E2E Other Salon",
    });
    const crossTenant = await controlTestOperationalException({
      salonId: wrongSalon.salonId,
      alertId: seeded.alertId,
      operation: "reopen",
      actorUserId: user.userId,
    });
    expect(crossTenant).toEqual({
      outcome: "not_found",
      alert_status: null,
    });
    await cleanupTestSalon(wrongSalon.slug);

    const state = await getOperationalExceptionState(
      salon.salonId,
      seeded.alertId,
    );
    expect(state.alert).toMatchObject({
      status: "resolved",
      acknowledged_by: user.userId,
      resolved_by: user.userId,
      resolution_note: "Reviewed staffing coverage and restored capacity.",
    });
    expect(state.alert.acknowledged_at).not.toBeNull();
    expect(state.alert.resolved_at).not.toBeNull();
    expect(state.audit.map((row) => row.action_type)).toEqual([
      "operational_exception_acknowledged",
      "operational_exception_resolved",
    ]);
    expect(state.audit).toHaveLength(2);
  });
});
