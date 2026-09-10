"use server";

type Auth = typeof import("../../src/shared/auth/emailPasswordAuth");

// Inert action references for the real form. Every request is intercepted by
// the browser spec; an interception failure must never reach a real backend.
export async function authenticateWithEmailPassword(
  ...args: Parameters<Auth["authenticateWithEmailPassword"]>
): Promise<Awaited<ReturnType<Auth["authenticateWithEmailPassword"]>>> {
  void args;
  throw new Error("QA action escaped browser interception");
}

export async function resendSignupConfirmationEmail(
  ...args: Parameters<Auth["resendSignupConfirmationEmail"]>
): Promise<Awaited<ReturnType<Auth["resendSignupConfirmationEmail"]>>> {
  void args;
  throw new Error("QA action escaped browser interception");
}
