import { describe, expect, it } from "vitest";
import { cancellationFeeReturnPath, withCancellationFeeReturnPath } from "../cancellationFeeReturnPath";

const target = "/dashboard/test-salon/cancellation-fee/4378c3c6-f485-4ab4-9cb2-2011e82f5d66";

describe("cancellation fee sign-in return allowlist", () => {
  it("preserves exactly the safe read-only fee page", () => {
    expect(cancellationFeeReturnPath(target)).toBe(target);
    expect(withCancellationFeeReturnPath("/login", target)).toBe(`/login?next=${encodeURIComponent(target)}`);
    expect(withCancellationFeeReturnPath("/login?error=session", target)).toBe(`/login?error=session&next=${encodeURIComponent(target)}`);
  });
  it.each([
    undefined, null, {}, [target], "", "https://evil.example", "//evil.example",
    `https://www.nailiq.ca${target}`, `${target}?charge=true`, `${target}#charge`,
    `${target}/`, `${target}\n`, `/dashboard/test-salon/cancellation-fee/not-a-uuid`,
    target.replace("test-salon", "test%2Fsalon"), target.replace("test-salon", ".."),
    target.replace("test-salon", "a\\evil"), target.replace("test-salon", "a".repeat(65)),
    "/dashboard/test-salon", "/api/booking/cancel-action", "/superadmin",
    `javascript:alert(1)`, `%2F${target}`, `${target}%0d%0aLocation:https://evil.example`,
  ])("ignores unsafe or out-of-scope return hint %j", (input) => {
    expect(cancellationFeeReturnPath(input)).toBeNull();
    expect(withCancellationFeeReturnPath("/login", input)).toBe("/login");
  });
});
