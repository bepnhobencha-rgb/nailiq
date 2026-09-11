"use server";
import type { CompletePasswordResetResult, SuperadminLoginResult, RequestPasswordResetResult } from "../../src/shared/superadmin/superadminAuth";
// Inert fixture only: no Auth client, credentials, or provider calls.
export async function completeSuperadminPasswordReset(password: string): Promise<CompletePasswordResetResult> {
  void password;
  throw new Error("QA action escaped browser interception");
}

export async function loginSuperadmin(email: string, password: string): Promise<SuperadminLoginResult> {
  void email; void password;
  throw new Error("QA action escaped browser interception");
}
export async function requestSuperadminPasswordReset(email: string): Promise<RequestPasswordResetResult> {
  void email;
  throw new Error("QA action escaped browser interception");
}
