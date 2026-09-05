import { expect, test, type Page } from "@playwright/test";
import {
  cleanupTestSalon,
  cleanupTestUser,
  attemptFinalGoLiveApprovalAsMember,
  changeFirstTestServicePrice,
  getGoLiveAttestationHistory,
  prepareTestSalonForGoLive,
  seedTestSalon,
  seedTestSalonMember,
} from "./helpers/db";

const SLUG = "e2e-go-live-readiness";
const READY_SLUG = "e2e-go-live-approval";
const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
let readySalonId = "";
let owner:
  | Awaited<ReturnType<typeof seedTestSalonMember>>
  | undefined;
let admin:
  | Awaited<ReturnType<typeof seedTestSalonMember>>
  | undefined;

async function loginAs(
  page: Page,
  account: { email: string; password: string },
) {
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute(
    "data-hydrated",
    "true",
  );
  await page.locator('input[inputmode="email"]').fill(account.email);
  await page.locator('input[type="password"]').fill(account.password);
  await page.getByTestId("password-signin-submit").click();
  await page.waitForURL(/\/dashboard\//, { timeout: 30_000 });
}

async function authAsDemoOwner(page: Page) {
  await page.context().addCookies([
    { name: "nailiq-demo-slug", value: SLUG, url: BASE },
  ]);
}

test.describe("Go-live readiness", () => {
  test.beforeAll(async () => {
    await seedTestSalon({
      slug: SLUG,
      name: "Readiness Test Salon",
      phone: "15553332001",
      salon_phone: "+15553332002",
      phone_otp_enabled: true,
    });
    const readySalon = await seedTestSalon({
      slug: READY_SLUG,
      name: "Approval Test Salon",
      phone: "15553332003",
      salon_phone: "+15553332004",
    });
    readySalonId = readySalon.salonId;
    await prepareTestSalonForGoLive(readySalonId);
    owner = await seedTestSalonMember(readySalonId, "owner");
    admin = await seedTestSalonMember(readySalonId, "admin");
  });

  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
    await cleanupTestSalon(READY_SLUG);
    if (owner) await cleanupTestUser(owner.userId);
    if (admin) await cleanupTestUser(admin.userId);
  });

  test("owner can open truthful readiness checks from Settings", async ({
    page,
  }) => {
    await authAsDemoOwner(page);
    await page.goto(`/dashboard/${SLUG}/settings`);

    const readinessLink = page.getByRole("link", {
      name: "Kiểm tra sẵn sàng go-live",
    });
    await expect(readinessLink).toBeVisible();
    await readinessLink.click();

    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${SLUG}/settings/readiness`),
    );
    await expect(page.getByTestId("go-live-readiness-summary")).toBeVisible();
    await expect(page.getByTestId("readiness-check-catalog")).toContainText(
      /1 dịch vụ đang hoạt động|1 active service/i,
    );
    await expect(page.getByTestId("readiness-check-staff")).toContainText(
      /1 nhân viên đang hoạt động|1 active staff member/i,
    );

    // The seeded salon deliberately has no address. The screen must fail
    // closed instead of trusting profile_complete alone.
    await expect(page.getByTestId("readiness-check-identity")).toContainText(
      /Cần sửa|Action/i,
    );
    await expect(
      page.getByTestId("readiness-check-human-approval"),
    ).toContainText(/Cần xác nhận|Review/i);
    await expect(page.getByText("Chưa sẵn sàng go-live")).toBeVisible();
  });

  test("real owner records prerequisites and final approval as immutable audit events", async ({
    page,
  }) => {
    if (!owner) throw new Error("owner fixture missing");

    await loginAs(page, owner);
    await page.goto(`/dashboard/${READY_SLUG}/settings/readiness`);

    await expect(page.getByTestId("go-live-readiness-summary")).toContainText(
      /5\/5/,
    );

    const steps = [
      ["hours_confirmed", "Owner confirmed Monday-Saturday opening hours."],
      [
        "otp_policy_confirmed",
        "Owner confirmed OTP is off and approved the consent policy.",
      ],
      [
        "live_rehearsal_completed",
        "Owner and receptionist completed one test booking and cleanup.",
      ],
      [
        "owner_approved",
        "Owner explicitly approved this salon configuration for go-live.",
      ],
    ] as const;

    for (const [key, note] of steps) {
      await page.getByTestId(`go-live-note-${key}`).fill(note);
      await page.getByTestId(`go-live-submit-${key}`).click();
      await expect(
        page.getByTestId(`go-live-attestation-${key}`),
      ).toContainText(/Đang hiệu lực|Active/i);
    }

    await expect(page.getByTestId("go-live-readiness-summary")).toContainText(
      /Đã được phê duyệt go-live|Approved for go-live/i,
    );

    await changeFirstTestServicePrice(readySalonId);
    await page.reload();
    await expect(
      page.getByTestId("go-live-attestation-owner_approved"),
    ).toContainText(/Cần phê duyệt lại|Reapproval required/i);
    await expect(page.getByTestId("go-live-readiness-summary")).not.toContainText(
      /Đã được phê duyệt go-live|Approved for go-live/i,
    );
    await page
      .getByTestId("go-live-note-owner_approved")
      .fill("Owner reviewed the changed service price and approved again.");
    await page.getByTestId("go-live-submit-owner_approved").click();
    await expect(page.getByTestId("go-live-readiness-summary")).toContainText(
      /Đã được phê duyệt go-live|Approved for go-live/i,
    );

    const history = await getGoLiveAttestationHistory(readySalonId);
    expect(history).toHaveLength(5);
    expect(history.map((event) => event.check_key)).toEqual(
      [...steps.map(([key]) => key), "owner_approved"],
    );
    expect(
      history.every(
        (event) =>
          event.action === "attest" &&
          event.actor_user_id === owner?.userId &&
          event.actor_role === "owner" &&
          typeof event.readiness_snapshot_hash === "string" &&
          event.readiness_snapshot_hash.length === 64,
      ),
    ).toBe(true);
  });

  test("admin can review records but cannot give final owner approval", async ({
    page,
  }) => {
    if (!admin) throw new Error("admin fixture missing");

    const directAttempt = await attemptFinalGoLiveApprovalAsMember({
      salonId: readySalonId,
      userId: admin.userId,
      email: admin.email,
      password: admin.password,
      actorRole: "admin",
    });
    expect(directAttempt.rejected).toBe(true);

    await loginAs(page, admin);
    await page.goto(`/dashboard/${READY_SLUG}/settings/readiness`);
    await expect(
      page.getByTestId("go-live-attestation-owner_approved"),
    ).toContainText(/Chỉ tài khoản Owner|Only an Owner account/i);
    await expect(
      page.getByTestId("go-live-submit-owner_approved"),
    ).toHaveCount(0);

    const history = await getGoLiveAttestationHistory(readySalonId);
    expect(history).toHaveLength(5);
    expect(history.every((event) => event.actor_role === "owner")).toBe(true);
  });

  test("owner cannot bypass readiness gates with a direct Data API insert", async () => {
    if (!owner) throw new Error("owner fixture missing");

    const directAttempt = await attemptFinalGoLiveApprovalAsMember({
      salonId: readySalonId,
      userId: owner.userId,
      email: owner.email,
      password: owner.password,
      actorRole: "owner",
    });
    expect(directAttempt.rejected).toBe(true);

    const history = await getGoLiveAttestationHistory(readySalonId);
    expect(history).toHaveLength(5);
  });
});
