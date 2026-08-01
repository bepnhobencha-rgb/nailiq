import { expect, test } from "@playwright/test";

import {
  cleanupTestSalon,
  getCampaignDispatchPreflightState,
  getCampaignReleaseState,
  getApprovalEffectState,
  recordTestCampaignManifest,
  recordTestCampaignDispatchPreflight,
  sealTestCampaignDispatchPlan,
  seedBulkMessageApproval,
  seedCampaignRecipient,
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

  test("campaign release is immutable, double-approved, and still never sends", async ({
    page,
    request,
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

    const baseURL =
      process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    await page.setViewportSize({ width: 390, height: 844 });
    await page.context().addCookies([
      {
        name: "nailiq-demo-slug",
        value: seededSalon.slug,
        url: baseURL,
      },
    ]);
    await page.goto(`/dashboard/${seededSalon.slug}/ai`);
    const prepareAudience = page.getByRole("button", {
      name: /Prepare audience|Chuẩn bị danh sách/,
    });
    await expect(prepareAudience).toBeVisible();
    expect((await prepareAudience.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
      44,
    );

    const clientProfileId = await seedCampaignRecipient();
    const concurrentResults = await Promise.all([
      recordTestCampaignManifest({
        salonId: seededSalon.salonId,
        jobId: jobId as string,
        clientProfileId,
      }),
      recordTestCampaignManifest({
        salonId: seededSalon.salonId,
        jobId: jobId as string,
        clientProfileId,
      }),
    ]);
    expect(concurrentResults.map((item) => item.outcome).sort()).toEqual([
      "created",
      "unchanged",
    ]);
    expect(concurrentResults[0]?.manifest_id).toBe(
      concurrentResults[1]?.manifest_id,
    );
    expect(concurrentResults[0]?.release_approval_id).toBe(
      concurrentResults[1]?.release_approval_id,
    );

    const prepared = await getCampaignReleaseState(jobId as string);
    expect(prepared.job.status).toBe("waiting_input");
    expect(prepared.job.result).toMatchObject({
      blocker: "release_approval_required",
      campaign_manifest_id: concurrentResults[0]?.manifest_id,
      release_approval_id: concurrentResults[0]?.release_approval_id,
      dispatch_enabled: false,
      no_messages_sent: true,
      audience_preparation: {
        eligible_count: 1,
        no_messages_sent: true,
      },
    });
    expect(prepared.manifests).toHaveLength(1);
    expect(prepared.manifest).toMatchObject({
      id: concurrentResults[0]?.manifest_id,
      source_execution_job_id: jobId,
      message: "We miss you — book your next nail appointment.",
    });
    expect(prepared.manifest?.message_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.recipients).toEqual([
      expect.objectContaining({
        manifest_id: concurrentResults[0]?.manifest_id,
        salon_id: seededSalon.salonId,
        client_profile_id: clientProfileId,
        sms: true,
        email: false,
      }),
    ]);
    expect(prepared.recipients[0]).not.toHaveProperty("phone");
    expect(prepared.recipients[0]).not.toHaveProperty("email_address");
    expect(prepared.releaseApproval).toMatchObject({
      id: concurrentResults[0]?.release_approval_id,
      status: "pending",
      release_manifest_id: concurrentResults[0]?.manifest_id,
      payload: {
        proposal_source: "campaign_release_gate",
        manifest_id: concurrentResults[0]?.manifest_id,
        recipient_selection_required: false,
        dispatch_enabled: false,
        dispatch_authorization_required: true,
        no_messages_sent: true,
      },
    });
    expect(prepared.audits).toHaveLength(1);
    expect(prepared.audits[0]?.payload).toMatchObject({
      manifest_id: concurrentResults[0]?.manifest_id,
      no_messages_sent: true,
    });

    await page.goto(
      `/api/ai/approve?token=${encodeURIComponent(
        prepared.releaseApproval?.approve_token as string,
      )}`,
    );
    await expect(
      page.getByRole("heading", { name: "Đưa hành động vào hàng đợi?" }),
    ).toBeVisible();
    const beforeFinalConfirmation = await getApprovalEffectState(
      prepared.releaseApproval?.id as string,
    );
    expect(beforeFinalConfirmation.approval.status).toBe("pending");
    expect(beforeFinalConfirmation.job).toBeNull();

    await page
      .getByRole("button", { name: "Xác nhận đồng ý" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Đề xuất đã được duyệt." }),
    ).toBeVisible();

    const approvedRelease = await getApprovalEffectState(
      prepared.releaseApproval?.id as string,
    );
    expect(approvedRelease.approval.status).toBe("approved");
    expect(approvedRelease.job).toMatchObject({
      status: "waiting_input",
      attempt_count: 0,
      result: { blocker: "dispatch_not_enabled" },
    });

    const cronSecret = process.env.CRON_SECRET?.trim();
    expect(cronSecret).toBeTruthy();
    const workerResponse = await request.get("/api/cron/ai-execution", {
      headers: { authorization: `Bearer ${cronSecret}` },
    });
    expect(workerResponse.ok()).toBeTruthy();
    const afterWorker = await getApprovalEffectState(
      prepared.releaseApproval?.id as string,
    );
    expect(afterWorker.job).toMatchObject({
      status: "waiting_input",
      attempt_count: 0,
      result: { blocker: "dispatch_not_enabled" },
    });
    expect(
      afterWorker.effects.filter((effect) =>
        [
          "sms_sent",
          "email_sent",
          "campaign_dispatched",
          "execution_succeeded",
        ].includes(effect.action_type),
      ),
    ).toEqual([]);

    const preflightResults = await Promise.all([
      recordTestCampaignDispatchPreflight({
        salonId: seededSalon.salonId,
        jobId: approvedRelease.job?.id as string,
        manifestId: concurrentResults[0]?.manifest_id as string,
        clientProfileId,
      }),
      recordTestCampaignDispatchPreflight({
        salonId: seededSalon.salonId,
        jobId: approvedRelease.job?.id as string,
        manifestId: concurrentResults[0]?.manifest_id as string,
        clientProfileId,
      }),
    ]);
    expect(preflightResults.map((item) => item.outcome).sort()).toEqual([
      "created",
      "unchanged",
    ]);
    expect(preflightResults[0]?.preflight_id).toBe(
      preflightResults[1]?.preflight_id,
    );
    expect(preflightResults[0]?.preflight_status).toBe("ready");
    expect(Date.parse(preflightResults[0]?.valid_until as string)).toBeGreaterThan(
      Date.now(),
    );
    expect(preflightResults[0]?.valid_until).toBe(
      preflightResults[1]?.valid_until,
    );
    expect(preflightResults[0]?.decision_count).toBe(1);

    const preflightState = await getCampaignDispatchPreflightState(
      approvedRelease.job?.id as string,
    );
    expect(preflightState.preflights).toHaveLength(1);
    expect(preflightState.decisions).toEqual([
      expect.objectContaining({
        preflight_id: preflightResults[0]?.preflight_id,
        salon_id: seededSalon.salonId,
        client_profile_id: clientProfileId,
        sms: true,
        email: false,
        exclusion: null,
      }),
    ]);
    expect(preflightState.job).toMatchObject({
      status: "waiting_input",
      attempt_count: 0,
      result: {
        blocker: "dispatch_not_enabled",
        dispatch_enabled: false,
        no_messages_sent: true,
        dispatch_preflight: {
          preflight_status: "ready",
          eligible_count: 1,
          sms_recipient_count: 1,
          estimated_cost_usd_cents: 0.8,
          within_recipient_cap: true,
          within_cost_cap: true,
          freshness_minutes: 5,
          valid_until: preflightResults[0]?.valid_until,
          dispatch_enabled: false,
          no_messages_sent: true,
        },
      },
    });

    const planResults = await Promise.all([
      sealTestCampaignDispatchPlan({
        salonId: seededSalon.salonId,
        jobId: approvedRelease.job?.id as string,
      }),
      sealTestCampaignDispatchPlan({
        salonId: seededSalon.salonId,
        jobId: approvedRelease.job?.id as string,
      }),
    ]);
    expect(planResults.map((item) => item.outcome).sort()).toEqual([
      "created",
      "unchanged",
    ]);
    expect(planResults[0]?.plan_id).toBe(planResults[1]?.plan_id);
    expect(planResults[0]?.plan_status).toBe("sealed");
    expect(planResults[0]?.plan_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(planResults[0]?.expires_at).toBe(
      preflightResults[0]?.valid_until,
    );

    const plannedState = await getCampaignDispatchPreflightState(
      approvedRelease.job?.id as string,
    );
    expect(plannedState.plans).toEqual([
      expect.objectContaining({
        id: planResults[0]?.plan_id,
        preflight_id: preflightResults[0]?.preflight_id,
        status: "sealed",
        recipient_count: 1,
        sms_recipient_count: 1,
        email_recipient_count: 0,
        dispatch_enabled: false,
        no_messages_sent: true,
      }),
    ]);
    expect(plannedState.job).toMatchObject({
      status: "waiting_input",
      attempt_count: 0,
      result: {
        blocker: "dispatch_not_enabled",
        dispatch_enabled: false,
        no_messages_sent: true,
        dispatch_plan: {
          plan_id: planResults[0]?.plan_id,
          plan_status: "sealed",
          recipient_count: 1,
          sms_recipient_count: 1,
          email_recipient_count: 0,
          dispatch_enabled: false,
          no_messages_sent: true,
        },
      },
    });
    expect(
      plannedState.audits.filter(
        (audit) =>
          audit.action_type === "campaign_dispatch_plan_sealed",
      ),
    ).toHaveLength(1);

    const workerAfterPreflight = await request.get(
      "/api/cron/ai-execution",
      {
        headers: { authorization: `Bearer ${cronSecret}` },
      },
    );
    expect(workerAfterPreflight.ok()).toBeTruthy();
    const afterPreflightWorker = await getApprovalEffectState(
      prepared.releaseApproval?.id as string,
    );
    expect(afterPreflightWorker.job).toMatchObject({
      status: "waiting_input",
      attempt_count: 0,
      result: {
        blocker: "dispatch_not_enabled",
        dispatch_enabled: false,
        no_messages_sent: true,
      },
    });
    expect(
      afterPreflightWorker.effects.filter((effect) =>
        [
          "sms_sent",
          "email_sent",
          "campaign_dispatched",
          "execution_succeeded",
        ].includes(effect.action_type),
      ),
    ).toEqual([]);
  });
});
