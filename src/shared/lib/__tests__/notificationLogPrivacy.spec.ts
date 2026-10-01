import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ result: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({
    rpc: mocks.rpc,
    from: () => {
      const chain = { insert: vi.fn(), update: vi.fn(), eq: vi.fn(), select: vi.fn(), maybeSingle: mocks.result };
      for (const method of [chain.insert, chain.update, chain.eq, chain.select]) method.mockReturnValue(chain);
      return chain;
    },
  }),
}));

import {
  claimNotificationOnce, completeReviewRequestSmsNotification,
  finalizeNotificationClaim, logNotification, updateNotificationBySid,
} from "@/shared/lib/notificationLog";

const privateCanary = "SYNTHETIC_RECEIPT_PRIVATE_CANARY";
const notification = {
  bookingId: "synthetic-booking", salonId: "synthetic-salon",
  notificationType: "booking_confirmation" as const, channel: "sms" as const,
};
const operations = [
  { name: "insert", run: () => logNotification({ ...notification, ok: false }), failure: null },
  { name: "claim", run: () => claimNotificationOnce(notification), failure: "unguarded" },
  { name: "finalize", run: () => finalizeNotificationClaim("synthetic-claim", { status: "unknown" }), failure: false },
  { name: "review complete", run: () => completeReviewRequestSmsNotification({ notificationId: "synthetic-claim", status: "unknown" }), failure: false },
  { name: "callback", run: () => updateNotificationBySid(`SM${"a".repeat(32)}`, "delivered"), failure: { ok: false, code: "database_error" } },
];

describe("notification receipt diagnostics privacy (no database or network)", () => {
  let errorLog: ReturnType<typeof vi.spyOn>;
  let network: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.resetAllMocks();
    network = vi.fn(() => { throw new Error("Network forbidden in receipt privacy tests"); });
    vi.stubGlobal("fetch", network);
    errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = {
      code: "PGRST116",
      message: `${privateCanary} token=SYNTHETIC_BEARER body=SYNTHETIC_SMS_BODY`,
      details: privateCanary,
    };
    mocks.result.mockResolvedValue({ data: null, error });
    mocks.rpc.mockResolvedValue({ data: null, error });
  });
  afterEach(() => {
    expect(network).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(operations)("keeps $name failure semantics but logs only a bounded database code", async ({ run, failure }) => {
    expect(await run()).toEqual(failure);
    expect(errorLog).toHaveBeenCalledTimes(1);
    const logged = errorLog.mock.calls.map((args: unknown[]) => args.map(String).join(" ")).join("\n");
    for (const privateText of [privateCanary, "SYNTHETIC_BEARER", "SYNTHETIC_SMS_BODY"]) {
      expect(logged.includes(privateText), "receipt diagnostics must not expose raw context").toBe(false);
    }
    expect(errorLog.mock.calls[0]?.[1]).toBe("database_error:PGRST116");
  });

  it.each(["42501", "23514", "40001", "P0001", "XX000", "PGRST301"])("preserves diagnostic code %s without raw text", async (code) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code, message: privateCanary } });
    await updateNotificationBySid(`SM${"a".repeat(32)}`, "failed");
    expect(errorLog).toHaveBeenCalledExactlyOnceWith("[updateNotificationBySid]", `database_error:${code}`);
  });

  it.each([undefined, null, 42501, "bad\ncode", privateCanary, "PGRST116:token=SECRET"])("rejects unstructured error code %s", async (code) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code, message: privateCanary } });
    await updateNotificationBySid(`SM${"a".repeat(32)}`, "failed");
    expect(errorLog).toHaveBeenCalledExactlyOnceWith("[updateNotificationBySid]", "database_error");
  });

  it.each(["finalize", "review complete", "callback"])("keeps thrown %s errors private", async (name) => {
    const error = new Error(`${privateCanary} token=SYNTHETIC_BEARER`);
    mocks.result.mockRejectedValue(error);
    mocks.rpc.mockRejectedValue(error);
    const operation = operations.find((entry) => entry.name === name)!;
    expect(await operation.run()).toEqual(operation.failure);
    expect(errorLog.mock.calls[0]?.[1]).toBe("database_error");
  });

  it("keeps expected duplicate claims silent and skipped", async () => {
    mocks.result.mockResolvedValue({ data: null, error: { code: "23505", message: privateCanary } });
    expect(await claimNotificationOnce(notification)).toBe("skip");
    expect(await logNotification({ ...notification, ok: false })).toBeNull();
    expect(errorLog).not.toHaveBeenCalled();
  });
});
