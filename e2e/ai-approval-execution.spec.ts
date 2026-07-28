import { expect, test } from "@playwright/test";

import {
  cleanupTestSalon,
  getAudiencePreparationState,
  getApprovalEffectState,
  recordTestAudiencePreparation,
  seedBulkMessageApproval,
  seedOperationalNoteApproval,
  seedTestSalon,
} from "./helpers/db";

test.describe("AI approval execution", () => {
  let testSlug: string;

  test.afterEach(async () => {
    if (testSlug) await cleanupTestSalon(testSlug);
  });

  test("explicit owner confirmation reaches one durable operational effect", async ({
    page,
    request,
  }) => {
    const seededSalon = await seedTestSalon({
      slug: `e2e-ai-approval-${test.info().workerIndex}`,
      name: "E2E AI Approval Salon",
      phone: "15553335555",
    });
    testSlug = seededSalon.slug;
    const seededApproval = await seedOperationalNoteApproval(
      seededSalon.salonId,
    );

    await page.goto(
      `/api/ai/approve?token=${encodeURIComponent(seededApproval.approveToken)}`,
    );
    await expect(
      page.getByRole("heading", { name: "Đưa hành động vào hàng đợi?" }),
    ).toBeVisible();
    await expect(page.getByText(seededApproval.summary)).toBeVisible();

    // GET is read-only: scanners and previews must not authorize execution.
    const beforeConfirmation = await getApprovalEffectState(
      seededApproval.approvalId,
    );
    expect(beforeConfirmation.approval.status).toBe("pending");
    expect(beforeConfirmation.job).toBeNull();
    expect(beforeConfirmation.effects).toEqual([]);

    await page
      .getByRole("button", { name: "Xác nhận đồng ý" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Hành động đã được xếp hàng an toàn." }),
    ).toBeVisible();

    const queued = await getApprovalEffectState(seededApproval.approvalId);
    expect(queued.approval.status).toBe("approved");
    expect(queued.approval.decided_at).not.toBeNull();
    expect(queued.job).toMatchObject({
      status: "queued",
      attempt_count: 0,
      lease_token: null,
    });
    expect(queued.effects).toEqual([]);

    const cronSecret = process.env.CRON_SECRET?.trim();
    expect(cronSecret, "CI must generate a throwaway cron secret").toBeTruthy();
    const workerResponse = await request.get("/api/cron/ai-execution", {
      headers: { authorization: `Bearer ${cronSecret}` },
    });
    expect(workerResponse.ok()).toBeTruthy();
    const workerResult = (await workerResponse.json()) as {
      claimed: number;
      succeeded: number;
      outcomes: Array<{ jobId: string; status: string }>;
    };
    expect(workerResult.claimed).toBeGreaterThanOrEqual(1);
    expect(workerResult.succeeded).toBeGreaterThanOrEqual(1);
    expect(workerResult.outcomes).toContainEqual({
      jobId: queued.job?.id,
      status: "succeeded",
      attempted: true,
    });

    const completed = await getApprovalEffectState(seededApproval.approvalId);
    expect(completed.job).toMatchObject({
      id: queued.job?.id,
      status: "succeeded",
      attempt_count: 1,
      lease_token: null,
      result: {
        effect: "internal_audit",
        audit_action_type: "approved_operational_note",
        approval_request_id: seededApproval.approvalId,
        note: seededApproval.note,
      },
    });
    expect(
      completed.effects.filter(
        (effect) => effect.action_type === "approved_operational_note",
      ),
    ).toHaveLength(1);
    expect(
      completed.effects.filter(
        (effect) => effect.action_type === "execution_succeeded",
      ),
    ).toHaveLength(1);

    // Replaying the same signed decision cannot enqueue or execute it twice.
    const replay = await request.post("/api/ai/approve", {
      headers: { origin: new URL(page.url()).origin },
      form: { token: seededApproval.approveToken },
    });
    expect(replay.ok()).toBeTruthy();
    expect(await replay.text()).toContain("Yêu cầu này đã được xử lý rồi.");

    const afterReplay = await getApprovalEffectState(seededApproval.approvalId);
    expect(afterReplay.job?.id).toBe(queued.job?.id);
    expect(
      afterReplay.effects.filter(
        (effect) => effect.action_type === "approved_operational_note",
      ),
    ).toHaveLength(1);
  });

  test("audience preparation is atomic, idempotent, and never sends", async ({
    page,
  }) => {
    const seededSalon = await seedTestSalon({
      slug: `e2e-ai-audience-${test.info().workerIndex}`,
      name: "E2E AI Audience Salon",
      phone: "15553336666",
    });
    testSlug = seededSalon.slug;
    const seededApproval = await seedBulkMessageApproval(seededSalon.salonId);

    await page.goto(
      `/api/ai/approve?token=${encodeURIComponent(seededApproval.approveToken)}`,
    );
    await page
      .getByRole("button", { name: "Xác nhận đồng ý" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Đề xuất đã được duyệt." }),
    ).toBeVisible();

    const waiting = await getApprovalEffectState(seededApproval.approvalId);
    expect(waiting.job).toMatchObject({
      status: "waiting_input",
      attempt_count: 0,
      lease_token: null,
    });
    const jobId = waiting.job?.id;
    expect(jobId).toBeTruthy();

    const fingerprint = "a".repeat(24);
    const concurrentResults = await Promise.all([
      recordTestAudiencePreparation({
        salonId: seededSalon.salonId,
        jobId: jobId as string,
        fingerprint,
      }),
      recordTestAudiencePreparation({
        salonId: seededSalon.salonId,
        jobId: jobId as string,
        fingerprint,
      }),
    ]);
    expect(concurrentResults.sort()).toEqual(["unchanged", "updated"]);

    const prepared = await getAudiencePreparationState(jobId as string);
    expect(prepared.job.status).toBe("waiting_input");
    expect(prepared.job.result).toMatchObject({
      blocker: "recipient_selection_required",
      audience_preparation: {
        audience_fingerprint: fingerprint,
        eligible_count: 1,
        no_messages_sent: true,
      },
    });
    expect(prepared.audits).toHaveLength(1);
    expect(prepared.audits[0]?.payload).toMatchObject({
      audience_fingerprint: fingerprint,
      no_messages_sent: true,
    });

    const changed = await recordTestAudiencePreparation({
      salonId: seededSalon.salonId,
      jobId: jobId as string,
      fingerprint: "b".repeat(24),
    });
    expect(changed).toBe("updated");
    const refreshed = await getAudiencePreparationState(jobId as string);
    expect(refreshed.job.status).toBe("waiting_input");
    expect(refreshed.audits).toHaveLength(2);
  });
});
