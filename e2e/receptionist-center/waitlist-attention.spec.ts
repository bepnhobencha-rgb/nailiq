import { expect, test, type Page } from "@playwright/test";

import { cleanupTestSalon, cleanupTestUser, seedTestUser } from "../helpers/db";
import { waitForReceptionistHydration } from "../helpers/receptionistHydration";
import {
  rcSlug,
  seedReceptionistCenterFixture,
  supabaseAdmin,
  type ReceptionistCenterFixture,
} from "./helpers";

type OwnerAccount = Awaited<ReturnType<typeof seedTestUser>>;

let fx: ReceptionistCenterFixture;
let owner: OwnerAccount;

function waitlistSlug(project: string): string {
  return `${rcSlug(project)}-waitlist`;
}

async function loginOwner(page: Page): Promise<void> {
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute(
    "data-hydrated",
    "true",
  );
  await page.locator('input[inputmode="email"]').fill(owner.email);
  await page.locator('input[type="password"]').fill(owner.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(/\/dashboard\//, { timeout: 30_000 });

  await page.goto(
    `/dashboard/${encodeURIComponent(fx.slug)}/center?date=${fx.ymdUtc}`,
  );
  await page
    .getByTestId("receptionist-center-loaded")
    .first()
    .waitFor({ state: "attached", timeout: 45_000 });
  await waitForReceptionistHydration(page, fx.slug);
}

test.beforeAll(async ({}, testInfo) => {
  fx = await seedReceptionistCenterFixture(waitlistSlug(testInfo.project.name));
  owner = await seedTestUser();

  const { data: salon, error: loadError } = await supabaseAdmin
    .from("salons")
    .select("feature_flags, dashboard_modules")
    .eq("id", fx.salonId)
    .single();
  if (loadError) throw new Error(`load waitlist fixture: ${loadError.message}`);

  const { error: updateError } = await supabaseAdmin
    .from("salons")
    .update({
      feature_flags: {
        ...((salon.feature_flags as Record<string, boolean> | null) ?? {}),
        waitlist_attention_enabled: true,
      },
      dashboard_modules: {
        ...((salon.dashboard_modules as Record<string, boolean> | null) ?? {}),
        sound_alerts: true,
      },
    } as never)
    .eq("id", fx.salonId);
  if (updateError) {
    throw new Error(`enable waitlist fixture: ${updateError.message}`);
  }

  const { error: memberError } = await supabaseAdmin
    .from("salon_members")
    .insert({ salon_id: fx.salonId, user_id: owner.userId, role: "owner" });
  if (memberError) {
    throw new Error(`seed waitlist owner: ${memberError.message}`);
  }
});

test.afterEach(async () => {
  await supabaseAdmin
    .from("booking_waitlist_entries")
    .delete()
    .eq("salon_id", fx.salonId);
});

test.afterAll(async ({}, testInfo) => {
  await cleanupTestSalon(waitlistSlug(testInfo.project.name));
  if (owner?.userId) await cleanupTestUser(owner.userId);
});

test("new Waitlist lead alerts once, reminds once, stays visible, and records acknowledgement", async ({
  page,
  isMobile,
}) => {
  test.skip(
    isMobile,
    "Desktop runtime proof is sufficient for the shared alert logic.",
  );

  // Replace Web Audio with an in-memory counter and accelerate only the
  // two-minute Waitlist reminder. No sound leaves the test browser and no
  // production timing constant is changed.
  await page.addInitScript(() => {
    const state = { starts: 0 };
    Object.defineProperty(window, "__nailiqWaitlistAudio", {
      configurable: true,
      value: state,
    });

    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) =>
      nativeSetTimeout(
        handler,
        timeout === 2 * 60 * 1000 ? 300 : timeout,
        ...args,
      )) as typeof window.setTimeout;

    class TestAudioContext {
      state: AudioContextState = "running";
      currentTime = 0;
      destination = {} as AudioDestinationNode;

      resume(): Promise<void> {
        this.state = "running";
        return Promise.resolve();
      }

      createOscillator(): OscillatorNode {
        return {
          type: "sine",
          frequency: { value: 0 },
          connect: (target: AudioNode) => target,
          start: () => {
            state.starts += 1;
          },
          stop: () => undefined,
        } as unknown as OscillatorNode;
      }

      createGain(): GainNode {
        return {
          gain: {
            setValueAtTime: () => undefined,
            linearRampToValueAtTime: () => undefined,
          },
          connect: (target: AudioNode) => target,
        } as unknown as GainNode;
      }
    }

    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: TestAudioContext,
    });
  });

  await loginOwner(page);

  // A real keyboard gesture unlocks the same hook path used at the front desk
  // without activating any control on the schedule.
  await page.keyboard.press("Shift");
  await expect(page.getByTestId("sound-locked-hint")).toHaveCount(0);

  const createdAt = new Date(Date.now() - 7 * 60 * 1000).toISOString();
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("booking_waitlist_entries")
    .insert({
      salon_id: fx.salonId,
      service_id: fx.serviceIds[0],
      booking_date: fx.ymdUtc,
      client_name: "E2E Waitlist Lead",
      client_phone: "16045550187",
      source: "slot_unavailable",
      status: "waiting",
      created_at: createdAt,
    } as never)
    .select("id")
    .single();
  if (insertError || !inserted?.id) {
    throw new Error(insertError?.message ?? "waitlist insert returned no id");
  }
  const entryId = String(inserted.id);

  // Authenticated Realtime refreshes the Action Center; the assertion budget
  // is well below the product's 60-second response objective.
  const waitlistChip = page.getByTestId("attention-chip-waitlist");
  await expect(waitlistChip).toBeVisible({ timeout: 20_000 });
  await expect(waitlistChip).toContainText("1");

  // The distinct Waitlist recipe has three tones. With the test-only accelerated
  // clock it plays immediately, once at the reminder, and never loops.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __nailiqWaitlistAudio: { starts: number };
              }
            ).__nailiqWaitlistAudio.starts,
        ),
      { timeout: 5_000 },
    )
    .toBe(6);
  await page.waitForTimeout(700);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __nailiqWaitlistAudio: { starts: number };
          }
        ).__nailiqWaitlistAudio.starts,
    ),
  ).toBe(6);

  await waitlistChip.click();
  await expect(page.getByTestId("online-waitlist-panel")).toBeVisible();
  await expect(page.getByTestId(`waitlist-entry-${entryId}`)).toContainText(
    "E2E Waitlist Lead",
  );
  await expect(page.getByTestId(`waitlist-age-${entryId}`)).toContainText(
    /7 min/,
  );
  await expect(page.getByTestId(`waitlist-invite-${entryId}`)).toBeVisible();

  // Opening the handling surface is an acknowledgement, not resolution.
  await expect
    .poll(async () => {
      const { data } = await supabaseAdmin
        .from("booking_waitlist_entries")
        .select("status, acknowledged_at, acknowledged_by_user_id")
        .eq("id", entryId)
        .eq("salon_id", fx.salonId)
        .maybeSingle();
      return data
        ? {
            status: data.status,
            acknowledged: Boolean(data.acknowledged_at),
            acknowledgedBy: data.acknowledged_by_user_id,
          }
        : null;
    })
    .toEqual({
      status: "waiting",
      acknowledged: true,
      acknowledgedBy: owner.userId,
    });

  await expect
    .poll(async () => {
      const { count } = await supabaseAdmin
        .from("booking_events")
        .select("*", { count: "exact", head: true })
        .eq("salon_id", fx.salonId)
        .eq("actor_user_id", owner.userId)
        .eq("event_type", "waitlist_acknowledged");
      return count ?? 0;
    })
    .toBe(1);

  // The suite leaves no QA Waitlist lead behind.
  const { error: cleanupError } = await supabaseAdmin
    .from("booking_waitlist_entries")
    .delete()
    .eq("id", entryId)
    .eq("salon_id", fx.salonId);
  if (cleanupError) throw new Error(cleanupError.message);
  const { count: remaining } = await supabaseAdmin
    .from("booking_waitlist_entries")
    .select("*", { count: "exact", head: true })
    .eq("id", entryId)
    .eq("salon_id", fx.salonId);
  expect(remaining ?? 0).toBe(0);
});
