import { createHash } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import {
  cleanupTestSalon,
  cleanupTestUser,
  seedTestSalonMember,
} from "../helpers/db";
import {
  gotoReceptionistCenter,
  rcSlug,
  seedReceptionistCenterFixture,
  supabaseAdmin,
  testClientNameMarker,
  type ReceptionistCenterFixture,
} from "./helpers";

let fixture: ReceptionistCenterFixture;
let owner: Awaited<ReturnType<typeof seedTestSalonMember>> | undefined;

async function loginAs(
  page: Page,
  account: { email: string; password: string },
): Promise<void> {
  const digest = createHash("sha256").update(account.email).digest("hex");
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `2001:db8::${digest.slice(0, 4)}:${digest.slice(4, 8)}`,
  });
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

function waitForRealtimeSubscription(page: Page, salonId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Realtime subscription did not acknowledge salon ${salonId}`));
    }, 15_000);

    page.on("websocket", (socket) => {
      if (!socket.url().includes("/realtime/v1/websocket")) return;
      socket.on("framereceived", ({ payload }) => {
        const frame =
          typeof payload === "string"
            ? payload
            : Buffer.from(payload).toString("utf8");
        if (
          frame.includes(`receptionist-center-${salonId}`) &&
          frame.includes('"phx_reply"') &&
          frame.includes('"status":"ok"')
        ) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  });
}

async function installSoundProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe = { starts: 0, resumes: 0 };
    Object.defineProperty(window, "__nailiqSoundProbe", {
      configurable: true,
      value: probe,
    });

    class FakeGain {
      gain = {
        setValueAtTime() {},
        linearRampToValueAtTime() {},
      };

      connect(destination: unknown): unknown {
        return destination;
      }
    }

    class FakeOscillator {
      type = "sine";
      frequency = { value: 0 };

      connect(node: unknown): unknown {
        return node;
      }

      start(): void {
        probe.starts += 1;
      }

      stop(): void {}
    }

    class FakeAudioContext {
      currentTime = 0;
      destination = {};
      state: "suspended" | "running" = "suspended";

      createGain(): FakeGain {
        return new FakeGain();
      }

      createOscillator(): FakeOscillator {
        return new FakeOscillator();
      }

      async resume(): Promise<void> {
        this.state = "running";
        probe.resumes += 1;
      }
    }

    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: FakeAudioContext,
    });
  });
}

async function soundStarts(page: Page): Promise<number> {
  return page.evaluate(() => {
    const probe = (
      window as typeof window & {
        __nailiqSoundProbe?: { starts: number };
      }
    ).__nailiqSoundProbe;
    return probe?.starts ?? -1;
  });
}

async function insertWaitingEntry(label: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("booking_waitlist_entries" as never)
    .insert({
      salon_id: fixture.salonId,
      service_id: fixture.serviceIds[0]!,
      booking_date: fixture.ymdUtc,
      client_name: label,
      client_phone: "16045552420",
      source: "slot_unavailable",
      status: "waiting",
    })
    .select("id")
    .single();
  const id = (data as { id?: string } | null)?.id;
  if (error || !id) throw new Error(error?.message ?? "waitlist insert failed");
  return id;
}

test.beforeAll(async ({}, testInfo) => {
  fixture = await seedReceptionistCenterFixture(rcSlug(testInfo.project.name));
  owner = await seedTestSalonMember(fixture.salonId, "owner");
  const { error } = await supabaseAdmin
    .from("salons")
    .update({
      feature_flags: {
        group_booking_enabled: true,
        waitlist_attention_enabled: true,
      },
      dashboard_modules: { sound_alerts: true },
    } as never)
    .eq("id", fixture.salonId);
  if (error) throw new Error(error.message);
});

test.afterAll(async ({}, testInfo) => {
  await cleanupTestSalon(rcSlug(testInfo.project.name));
  if (owner) await cleanupTestUser(owner.userId);
});

test("QA-only waitlist attention refreshes, sounds once, and stops after viewing", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "Measured once on authenticated desktop Chromium.",
  );
  expect(owner, "authenticated owner fixture").toBeDefined();

  await installSoundProbe(page);
  const realtimeReady = waitForRealtimeSubscription(page, fixture.salonId);
  await loginAs(page, owner!);
  await gotoReceptionistCenter(page, fixture.slug, {
    useDemoCookie: false,
  });
  await realtimeReady;

  await page.keyboard.press("Tab");
  await expect(page.getByTestId("sound-locked-hint")).toHaveCount(0);
  await page.clock.install();
  expect(await soundStarts(page)).toBe(0);

  const firstName = testClientNameMarker();
  const firstId = await insertWaitingEntry(firstName);
  const acceptedAt = Date.now();
  await expect(page.getByTestId(`waitlist-entry-${firstId}`)).toContainText(
    firstName,
    { timeout: 5_000 },
  );
  expect(Date.now() - acceptedAt).toBeLessThanOrEqual(5_000);
  await expect.poll(() => soundStarts(page)).toBe(3);

  const chip = page.getByTestId("attention-chip-waitlist");
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(chip).toHaveAttribute("aria-expanded", "true");
  const waitlistDialog = page.getByRole("dialog");
  await expect(waitlistDialog.getByTestId(`waitlist-age-${firstId}`)).toContainText(
    /Waiting/,
  );
  await expect(
    waitlistDialog.getByTestId(`waitlist-invite-${firstId}`),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(chip).toHaveAttribute("aria-expanded", "false");

  await page.clock.fastForward(120_001);
  expect(await soundStarts(page)).toBe(3);

  const secondId = await insertWaitingEntry(testClientNameMarker());
  await expect(page.getByTestId(`waitlist-entry-${secondId}`)).toBeAttached({
    timeout: 5_000,
  });
  await expect.poll(() => soundStarts(page)).toBe(6);
  await page.clock.fastForward(120_001);
  await expect.poll(() => soundStarts(page)).toBe(9);
  await page.clock.fastForward(300_000);
  expect(await soundStarts(page)).toBe(9);
});
