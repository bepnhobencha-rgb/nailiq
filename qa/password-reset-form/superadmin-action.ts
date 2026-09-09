"use server";
import type { CompletePasswordResetResult } from "../../src/shared/superadmin/superadminAuth";
// Inert fixture only: no Auth client, credentials, or provider calls.
export async function completeSuperadminPasswordReset(password: string): Promise<CompletePasswordResetResult> {
  void password;
  throw new Error("QA action escaped browser interception");
}
