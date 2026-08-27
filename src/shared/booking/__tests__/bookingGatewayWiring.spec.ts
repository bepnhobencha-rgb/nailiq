import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  fs.readFileSync(path.join(process.cwd(), relative), "utf8");

const publicIndividual = read("src/shared/booking/submitPublicBooking.ts");
const group = read("src/shared/booking/submitGroupBooking.ts");
const desk = read("src/shared/dashboard/receptionistActions.ts");
const voice = read("src/shared/voiceai/toolExecutor.ts");
const wix = read("src/shared/integrations/wix/sync.ts");
const square = read("src/shared/integrations/square/sync.ts");
const chat = read("src/app/api/chat/booking/route.ts");

function requireRoute(
  source: string,
  gateway: string,
  intent: string,
  operation: string,
) {
  expect(source).toContain("runBookingOrchestrator");
  expect(source).toMatch(
    new RegExp(
      `gateway:\\s*["']${gateway}["'][\\s\\S]{0,120}` +
        `intent:\\s*["']${intent}["'][\\s\\S]{0,120}` +
        `operation:\\s*["']${operation}["']`,
    ),
  );
}

describe("booking gateway orchestrator wiring", () => {
  it("routes every V1 booking gateway through the shared boundary", () => {
    requireRoute(publicIndividual, "online", "individual", "commit");
    requireRoute(desk, "desk", "individual", "commit");
    requireRoute(desk, "walkin", "operational_arrival", "commit");
    requireRoute(voice, "voice", "individual", "commit");
    requireRoute(voice, "voice", "group", "commit");
    requireRoute(wix, "wix", "external_import", "reconcile");
    requireRoute(square, "square", "external_import", "reconcile");
  });

  it("routes both online and desk groups through the shared group engine", () => {
    expect(group).toContain("runBookingOrchestrator");
    expect(group).toMatch(/params\.bookingChannel === ["']desk["']/);
    expect(desk).toMatch(/createDeskGroup[\s\S]*submitGroupBooking/);
  });

  it("keeps chat explicitly assist-only", () => {
    requireRoute(chat, "chat", "assist", "assist");
    expect(chat).toContain("You do not have live availability or authoritative current pricing");
  });
});
