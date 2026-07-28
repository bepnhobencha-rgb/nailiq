import { expect, test } from "@playwright/test";

import {
  cleanupTestSalon,
  getApprovalEffectState,
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
});
