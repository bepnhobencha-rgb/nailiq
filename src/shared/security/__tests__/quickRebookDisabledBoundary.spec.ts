import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function productionSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return productionSources(path);
    if (!/\.(?:ts|tsx)$/.test(entry.name)) return [];
    if (/\.(?:spec|test)\.(?:ts|tsx)$/.test(entry.name)) return [];
    return [path];
  });
}

const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("disabled quick-rebook production boundary", () => {
  it("has no production caller for the retired privileged endpoint", () => {
    const callers = productionSources(resolve(root, "src"))
      .filter((file) => relative(root, file) !== "src/app/api/quick-rebook/route.ts")
      .filter((file) => readFileSync(file, "utf8").includes("/api/quick-rebook"))
      .map((file) => relative(root, file));

    expect(callers).toEqual([]);
  });

  it("keeps the route free of service-role, customer-history, and booking writes", () => {
    const route = read("src/app/api/quick-rebook/route.ts");

    expect(route).toContain("status: 410");
    expect(route).not.toContain("createServiceRoleClient");
    expect(route).not.toMatch(/\.(?:from|rpc)\(/);
    expect(route).not.toContain("client_phone");
    expect(route).not.toContain("customer_booking_patterns");
  });

  it("preserves OTP-gated rebook prefill through the normal idempotent submit", () => {
    const switcher = read("src/components/booking/BookingTypeSwitcher.tsx");
    const phonePanel = read("src/components/booking/BookingFlowPhonePanel.tsx");
    const flow = read("src/components/booking/useBookingFlowState.ts");

    expect(switcher).toContain("/api/customer/profile-verified?otp_session_id=");
    expect(switcher).toContain(
      "const flowReady = gateReady && (!salon.phoneOtpEnabled || gateOtpDone)",
    );
    expect(switcher).toContain("initialOtpSessionId: gateOtpSessionId");
    expect(phonePanel).toContain("onRebook(returningCustomer.lastBooking!)");
    expect(flow).toContain("const handleRebook = useCallback(");
    expect(flow).toContain('setStep("time")');
    expect(flow).toContain("submitPublicBooking({");
    expect(flow).toContain("otpSessionId: otpSessionId ?? null");
    expect(flow).toContain("idempotencyKey: bookingSubmitIdempotencyKeyRef.current");
    expect(flow).not.toContain("/api/quick-rebook");
  });
});
