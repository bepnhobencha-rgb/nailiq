import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  track: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mocks.create };
  },
}));
vi.mock("@/shared/ai/usageLedger", () => ({
  trackAnthropicMessage: mocks.track,
}));

import {
  draftReminderLead,
  guardReminderLead,
} from "@/shared/reminders/agentSmartReminder";

const input = {
  salonId: "salon-test",
  clientName: "Jamie",
  serviceName: "Head Spa",
  salonName: "Test Salon",
  whenLabel: "tomorrow",
  timeLabel: "2:30 PM",
  riskScore: 72,
  lang: "en" as const,
};

describe("AI Smart Reminder", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mocks.create.mockReset();
    mocks.track.mockReset();
    mocks.track.mockImplementation(async (_context, execute) => execute());
  });

  it("records a tenant-scoped model call and returns the drafted lead", async () => {
    mocks.create.mockResolvedValue({
      content: [{ type: "text", text: '"Test Salon: Head Spa tomorrow at 2:30 PM. Please confirm your spot."' }],
      usage: { input_tokens: 10, output_tokens: 8 },
    });

    await expect(draftReminderLead(input)).resolves.toBe(
      "Test Salon: Head Spa tomorrow at 2:30 PM. Please confirm your spot.",
    );
    expect(mocks.track).toHaveBeenCalledWith(
      {
        salonId: "salon-test",
        feature: "smart_reminder",
        model: "claude-haiku-4-5-20251001",
      },
      expect.any(Function),
    );
  });

  it("falls back safely when the tracked model call fails", async () => {
    mocks.create.mockRejectedValue(new Error("provider unavailable"));

    await expect(draftReminderLead(input)).resolves.toBeNull();
    expect(mocks.track).toHaveBeenCalledTimes(1);
  });

  it("removes links and emoji but rejects text missing the salon name", () => {
    expect(
      guardReminderLead(
        "Test Salon: Head Spa tomorrow at 2:30 PM. Confirm https://example.com ✨",
        "Test Salon",
      ),
    ).toBe("Test Salon: Head Spa tomorrow at 2:30 PM. Confirm");
    expect(guardReminderLead("Your appointment is tomorrow.", "Test Salon"))
      .toBeNull();
  });
});
