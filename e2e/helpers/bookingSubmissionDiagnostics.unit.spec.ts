import { describe, expect, it, vi } from "vitest";

import { withBookingSubmissionDiagnostics } from "./bookingSubmissionDiagnostics";

function fixture() {
  const page = {
    on: vi.fn(),
    off: vi.fn(),
    evaluate: vi.fn().mockResolvedValue({ successMounted: false }),
  } as unknown as Parameters<typeof withBookingSubmissionDiagnostics>[0];
  const info = {
    attach: vi.fn().mockResolvedValue(undefined),
  } as unknown as Parameters<typeof withBookingSubmissionDiagnostics>[1];
  return { page, info };
}

describe("booking submission diagnostics", () => {
  it("records only a synthetic booking count and preserves the original failure", async () => {
    const { page, info } = fixture();
    const readCount = vi.fn().mockResolvedValue(1);

    await expect(withBookingSubmissionDiagnostics(
      page,
      info,
      async () => { throw new Error("original assertion"); },
      readCount,
    )).rejects.toThrow("original assertion");

    expect(readCount).toHaveBeenCalledOnce();
    const attachment = vi.mocked(info.attach).mock.calls[0]?.[1];
    const body = JSON.parse(String(attachment?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ failed: true, syntheticBookingCount: 1 });
    expect(body).not.toHaveProperty("bookingId");
  });

  it("does not query the database after a passing booking test", async () => {
    const { page, info } = fixture();
    const readCount = vi.fn().mockResolvedValue(1);

    await withBookingSubmissionDiagnostics(page, info, async () => undefined, readCount);

    expect(readCount).not.toHaveBeenCalled();
    const attachment = vi.mocked(info.attach).mock.calls[0]?.[1];
    const body = JSON.parse(String(attachment?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ failed: false, syntheticBookingCount: "not_checked" });
  });

  it("keeps the original failure when the synthetic database read fails", async () => {
    const { page, info } = fixture();

    await expect(withBookingSubmissionDiagnostics(
      page,
      info,
      async () => { throw new Error("original assertion"); },
      async () => { throw new Error("database unavailable"); },
    )).rejects.toThrow("original assertion");

    const attachment = vi.mocked(info.attach).mock.calls[0]?.[1];
    const body = JSON.parse(String(attachment?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ failed: true, syntheticBookingCount: "unavailable" });
    expect(JSON.stringify(body)).not.toContain("database unavailable");
  });
});
