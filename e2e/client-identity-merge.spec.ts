import { expect, test, type Page } from "@playwright/test";
import {
  cleanupClientProfile,
  cleanupTestSalon,
  cleanupTestUser,
  seedTestSalon,
  seedTestSalonMember,
} from "./helpers/db";
import {
  seedDeskBooking,
  supabaseAdmin,
} from "./receptionist-center/helpers";

const SLUG = `e2e-client-identity-${process.env.GITHUB_RUN_ID ?? Date.now()}`;
let salonId = "";
let owner:
  | Awaited<ReturnType<typeof seedTestSalonMember>>
  | undefined;
let canonicalProfileId = "";
let aliasProfileId = "";
let canonicalPhone = "";
let aliasPhone = "";
let serviceId = "";
let staffId = "";

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
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(/\/dashboard\//, { timeout: 30_000 });
}

test.describe("reversible salon client identity merge", () => {
  test.beforeAll(async () => {
    const salon = await seedTestSalon({
      slug: SLUG,
      name: "Identity Review Test Salon",
      phone: "15553337771",
    });
    salonId = salon.salonId;
    owner = await seedTestSalonMember(salonId, "owner");
    const { error: reportsFlagError } = await supabaseAdmin
      .from("salons")
      .update({
        feature_flags: { reports_enabled: true },
        subscription_plan: "premium",
      })
      .eq("id", salonId);
    if (reportsFlagError) throw new Error(reportsFlagError.message);

    const suffix = String(Date.now()).slice(-7);
    canonicalPhone = `1604${suffix}`;
    aliasPhone = `1778${suffix}`;
    const sharedEmail = `identity-${suffix}@example.test`;
    const { data: profiles, error: profileError } = await supabaseAdmin
      .from("client_profiles")
      .insert([
        {
          phone: canonicalPhone,
          name: "Identity Test Customer",
          email: sharedEmail,
        },
        {
          phone: aliasPhone,
          name: "Identity Test Customer",
          email: sharedEmail,
        },
      ])
      .select("id, phone");
    if (profileError || !profiles || profiles.length !== 2) {
      throw new Error(
        `Failed to seed identity profiles: ${profileError?.message ?? "missing rows"}`,
      );
    }
    const canonical = profiles.find(
      (row) => String(row.phone) === canonicalPhone,
    );
    const alias = profiles.find(
      (row) => String(row.phone) === aliasPhone,
    );
    if (!canonical?.id || !alias?.id) {
      throw new Error("Seeded identity profiles could not be resolved");
    }
    canonicalProfileId = String(canonical.id);
    aliasProfileId = String(alias.id);
    canonicalPhone = String(canonical.phone);
    aliasPhone = String(alias.phone);

    const { error: linkError } = await supabaseAdmin
      .from("salon_clients")
      .insert([
        {
          salon_id: salonId,
          client_profile_id: canonicalProfileId,
          source: "manual",
        },
        {
          salon_id: salonId,
          client_profile_id: aliasProfileId,
          source: "manual",
        },
      ]);
    if (linkError) throw new Error(linkError.message);

    const [{ data: services }, { data: staff }] = await Promise.all([
      supabaseAdmin
        .from("services")
        .select("id")
        .eq("salon_id", salonId)
        .limit(1),
      supabaseAdmin
        .from("staff")
        .select("id")
        .eq("salon_id", salonId)
        .limit(1),
    ]);
    serviceId = String(services?.[0]?.id ?? "");
    staffId = String(staff?.[0]?.id ?? "");
    if (!serviceId || !staffId) throw new Error("Salon fixture is incomplete");
  });

  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
    if (owner) await cleanupTestUser(owner.userId);
    await cleanupClientProfile(canonicalPhone);
    await cleanupClientProfile(aliasPhone);
  });

  test("owner merges, future bookings resolve canonically, and undo restores the alias", async ({
    page,
  }) => {
    if (!owner) throw new Error("Owner fixture missing");
    await loginAs(page, owner);
    await page.goto(`/dashboard/${SLUG}/clients`);

    const candidateKey = [canonicalProfileId, aliasProfileId].sort().join(":");
    const candidate = page.getByTestId(`identity-candidate-${candidateKey}`);
    await expect(candidate).toBeVisible();

    await candidate
      .getByTestId(`identity-profile-${canonicalProfileId}`)
      .locator("..")
      .getByRole("button", { name: "Keep this identity" })
      .click();
    await candidate
      .getByLabel("Review evidence")
      .fill("Owner verified matching email and customer contact details.");
    await candidate.getByLabel(/I reviewed both records/).check();
    await candidate.getByRole("button", { name: "Merge profiles" }).click();

    await expect(page.getByText(/Identity updated/)).toBeVisible();
    await expect(page.getByText("Active merges")).toBeVisible();

    const { data: activeAlias, error: activeAliasError } = await supabaseAdmin
      .from("salon_client_identity_aliases" as never)
      .select("id, active")
      .eq("salon_id" as never, salonId)
      .eq("alias_profile_id" as never, aliasProfileId)
      .single();
    if (activeAliasError || !activeAlias) {
      throw new Error(activeAliasError?.message ?? "Active alias missing");
    }
    expect((activeAlias as { active: boolean }).active).toBe(true);

    const start = new Date(Date.now() + 7 * 86_400_000);
    start.setUTCHours(18, 0, 0, 0);
    const end = new Date(start.getTime() + 45 * 60_000);
    const bookingId = await seedDeskBooking(salonId, {
      clientName: "Identity Test Customer",
      clientPhone: aliasPhone,
      serviceId,
      staffId,
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      status: "confirmed",
    });
    const { data: mergedBooking } = await supabaseAdmin
      .from("bookings")
      .select("client_profile_id, client_phone")
      .eq("id", bookingId)
      .single();
    expect(mergedBooking?.client_profile_id).toBe(canonicalProfileId);
    expect(mergedBooking?.client_phone).toBe(aliasPhone);

    // Reports is server-rendered without a client hydration boundary. Keep this
    // real route and a range navigation in the identity flow so App Router and
    // range-query regressions cannot hide behind unit-only coverage.
    // The legacy /reports URL must redirect at the HTTP layer, before React or
    // RSC mounts. A component-level App Router redirect regressed production
    // with React #310 even though fixture-based navigation reached Insights.
    const legacyRedirect = await page.context().request.get(
      `/dashboard/${SLUG}/reports?range=week`,
      { maxRedirects: 0 },
    );
    expect(legacyRedirect.status()).toBe(307);
    expect(legacyRedirect.headers().location).toBe(
      `/dashboard/${SLUG}/insights?range=week`,
    );

    await page.goto(`/dashboard/${SLUG}/reports`);
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${SLUG}/insights$`),
    );
    await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
    await expect(page.getByText("This page couldn’t load")).toHaveCount(0);
    await expect(page.getByTestId("reports-kpis")).not.toContainText("—");
    await page.getByRole("tab", { name: "This week" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${SLUG}/insights\\?range=week$`),
    );
    await expect(page.getByTestId("reports-range-week")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByTestId("reports-kpis")).not.toContainText("—");

    await page.goto(`/dashboard/${SLUG}/clients`);
    await page.reload();
    await page.getByRole("button", { name: "Undo merge" }).click();
    await page
      .getByLabel("Why should this merge be undone?")
      .fill("Owner found the records belong to two different customers.");
    await page.getByRole("button", { name: "Undo merge" }).click();

    await expect(page.getByText(/Identity updated/)).toBeVisible();
    const { data: restoredBooking } = await supabaseAdmin
      .from("bookings")
      .select("client_profile_id, client_phone")
      .eq("id", bookingId)
      .single();
    expect(restoredBooking?.client_profile_id).toBe(aliasProfileId);
    expect(restoredBooking?.client_phone).toBe(aliasPhone);

    const { data: events } = await supabaseAdmin
      .from("salon_client_identity_merge_events" as never)
      .select("action, actor_user_id")
      .eq("salon_id" as never, salonId)
      .order("created_at" as never, { ascending: true });
    expect(
      (events as unknown as Array<{
        action: string;
        actor_user_id: string;
      }>).map((event) => event.action),
    ).toEqual(["merge", "revoke"]);
    expect(
      (events as unknown as Array<{ actor_user_id: string }>).every(
        (event) => event.actor_user_id === owner?.userId,
      ),
    ).toBe(true);
  });
});
