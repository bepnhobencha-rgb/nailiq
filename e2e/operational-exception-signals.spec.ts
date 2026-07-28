import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";

import {
  cleanupTestSalon,
  exerciseExecutionJobExceptionTrigger,
  getOperationalExceptionByDedupe,
  recordTestOperationalExceptionSignal,
  seedTestSalon,
} from "./helpers/db";

test.describe("AI operational exception signals", () => {
  let testSlug = "";

  test.afterEach(async () => {
    if (testSlug) await cleanupTestSalon(testSlug);
  });

  test("opens once, counts repeats, auto-resolves, and reopens a new incident", async () => {
    const salon = await seedTestSalon({
      slug: `e2e-ai-signal-${test.info().workerIndex}`,
      name: "E2E AI Signal Salon",
    });
    testSlug = salon.slug;
    const dedupeKey = `e2e-signal:${randomUUID()}`;
    const firstAt = "2026-07-28T11:30:00.000Z";
    const repeatAt = "2026-07-28T11:31:00.000Z";
    const recoveredAt = "2026-07-28T11:32:00.000Z";
    const reopenedAt = "2026-07-28T11:33:00.000Z";

    const [first, concurrentRepeat] = await Promise.all([
      recordTestOperationalExceptionSignal({
        salonId: salon.salonId,
        dedupeKey,
        sourceType: "e2e_worker",
        sourceRef: "bounded-job",
        signal: "firing",
        now: firstAt,
      }),
      recordTestOperationalExceptionSignal({
        salonId: salon.salonId,
        dedupeKey,
        sourceType: "e2e_worker",
        sourceRef: "bounded-job",
        signal: "firing",
        now: repeatAt,
      }),
    ]);
    expect(new Set([first.outcome, concurrentRepeat.outcome])).toEqual(
      new Set(["opened", "repeated"]),
    );
    expect(first.alert_id ?? concurrentRepeat.alert_id).toBeTruthy();

    let rows = await getOperationalExceptionByDedupe(
      salon.salonId,
      dedupeKey,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "open",
      source_type: "e2e_worker",
      source_ref: "bounded-job",
      occurrence_count: 2,
      resolved_at: null,
    });

    const recovered = await recordTestOperationalExceptionSignal({
      salonId: salon.salonId,
      dedupeKey,
      sourceType: "e2e_worker",
      sourceRef: "bounded-job",
      signal: "recovered",
      now: recoveredAt,
    });
    expect(recovered).toMatchObject({
      outcome: "resolved",
      alert_status: "resolved",
    });

    const reopened = await recordTestOperationalExceptionSignal({
      salonId: salon.salonId,
      dedupeKey,
      sourceType: "e2e_worker",
      sourceRef: "bounded-job",
      signal: "firing",
      now: reopenedAt,
    });
    expect(reopened).toMatchObject({
      outcome: "opened",
      alert_status: "open",
    });
    expect(reopened.alert_id).not.toBe(recovered.alert_id);

    rows = await getOperationalExceptionByDedupe(salon.salonId, dedupeKey);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status)).toEqual(["resolved", "open"]);
    expect(rows[0].resolution_note).toBe(
      "Recovered automatically after a successful run.",
    );
    expect(rows[1].occurrence_count).toBe(1);
  });

  test("tracks an exhausted execution job and its later recovery", async () => {
    const salon = await seedTestSalon({
      slug: `e2e-ai-job-signal-${test.info().workerIndex}`,
      name: "E2E AI Job Signal Salon",
    });
    testSlug = salon.slug;

    const state = await exerciseExecutionJobExceptionTrigger(salon.salonId);
    expect(state.opened).toHaveLength(1);
    expect(state.opened[0]).toMatchObject({
      status: "open",
      source_type: "ai_execution",
      source_ref: state.jobId,
      occurrence_count: 1,
    });
    expect(JSON.stringify(state.opened)).not.toContain(
      "this raw error must not enter the exception",
    );
    expect(state.resolved).toHaveLength(1);
    expect(state.resolved[0]).toMatchObject({
      status: "resolved",
      source_type: "ai_execution",
      source_ref: state.jobId,
    });
    expect(state.resolved[0].resolved_at).not.toBeNull();
  });
});
