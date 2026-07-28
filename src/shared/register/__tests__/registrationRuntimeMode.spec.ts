import { describe, expect, it } from "vitest";
import { shouldUseAnonymousDemoRegistration } from "../registrationRuntimeMode";

describe("shouldUseAnonymousDemoRegistration", () => {
  it.each([
    {
      isDemoRuntime: true,
      hasAuthenticatedUser: false,
      expected: true,
      scenario: "anonymous demo visitor",
    },
    {
      isDemoRuntime: true,
      hasAuthenticatedUser: true,
      expected: false,
      scenario: "authenticated E2E or development owner",
    },
    {
      isDemoRuntime: false,
      hasAuthenticatedUser: true,
      expected: false,
      scenario: "authenticated production owner",
    },
    {
      isDemoRuntime: false,
      hasAuthenticatedUser: false,
      expected: false,
      scenario: "anonymous production visitor",
    },
  ])("$scenario", ({ isDemoRuntime, hasAuthenticatedUser, expected }) => {
    expect(
      shouldUseAnonymousDemoRegistration(
        isDemoRuntime,
        hasAuthenticatedUser,
      ),
    ).toBe(expected);
  });
});
