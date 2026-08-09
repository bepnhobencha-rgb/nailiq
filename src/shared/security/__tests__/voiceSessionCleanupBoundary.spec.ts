import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(file, "utf8");

describe("stale voice session cleanup boundary", () => {
  const route = read("src/app/api/cron/close-stale-in-progress/route.ts");
  const vercel = read("vercel.json");
  const operatingState = read("src/shared/operations/cronOperatingState.ts");

  it("only changes expired sessions that are still active", () => {
    expect(route).toContain('.from("voice_ai_sessions")');
    expect(route).toContain('.update({ status: "abandoned" } as never)');
    expect(route).toContain('.eq("status", "active")');
    expect(route).toContain('.lt("started_at", voiceCutoff)');
    expect(route).toContain("SESSION_TTL_SECONDS");
    expect(route).toContain("VOICE_SESSION_GRACE_MINUTES");
  });

  it("runs hourly and exposes the same cadence to operations", () => {
    const crons = JSON.parse(vercel) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    expect(
      crons.crons.find(
        (cron) => cron.path === "/api/cron/close-stale-in-progress",
      )?.schedule,
    ).toBe("0 * * * *");
    expect(operatingState).toContain(
      'label: "Close stale operational states", schedule: "Hourly"',
    );
  });
});
