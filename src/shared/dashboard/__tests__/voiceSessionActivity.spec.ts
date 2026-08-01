import { describe, expect, it } from "vitest";

import {
  voiceSessionDisplayStatus,
  voiceSessionStatusLabel,
} from "../voiceSessionActivity";

const NOW = Date.parse("2026-08-01T19:00:00.000Z");

describe("voiceSessionDisplayStatus", () => {
  it("keeps a recent active session active", () => {
    expect(
      voiceSessionDisplayStatus(
        "active",
        "2026-08-01T18:45:00.000Z",
        null,
        NOW,
      ),
    ).toBe("active");
  });

  it("marks an active row older than the realtime lifetime as interrupted", () => {
    expect(
      voiceSessionDisplayStatus(
        "active",
        "2026-07-20T04:03:47.957Z",
        null,
        NOW,
      ),
    ).toBe("interrupted");
  });

  it("never rewrites a terminal status", () => {
    expect(
      voiceSessionDisplayStatus(
        "completed",
        "2026-07-20T04:03:47.957Z",
        null,
        NOW,
      ),
    ).toBe("completed");
    expect(
      voiceSessionDisplayStatus(
        "abandoned",
        "2026-07-20T04:03:47.957Z",
        null,
        NOW,
      ),
    ).toBe("abandoned");
  });

  it("fails closed for an unknown persisted status", () => {
    expect(
      voiceSessionDisplayStatus("mystery", "2026-08-01T18:59:00Z", null, NOW),
    ).toBe("failed");
  });
});

describe("voiceSessionStatusLabel", () => {
  it("gives every call state an operational Vietnamese label", () => {
    expect(voiceSessionStatusLabel("active")).toBe("Đang gọi");
    expect(voiceSessionStatusLabel("completed")).toBe("Hoàn tất");
    expect(voiceSessionStatusLabel("failed")).toBe("Lỗi");
    expect(voiceSessionStatusLabel("abandoned")).toBe("Đã kết thúc");
    expect(voiceSessionStatusLabel("interrupted")).toBe("Gián đoạn");
  });
});
