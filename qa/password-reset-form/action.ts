"use server";
import type { CompletePasswordResetResult } from "../../src/shared/auth/salonOwnerAuth";
// No Auth client, credentials, database, or provider call exists in this fixture.
// All action requests must be intercepted by the browser test.
export async function completeSalonOwnerPasswordReset(password: string): Promise<CompletePasswordResetResult> {
  void password;
  throw new Error("QA action escaped browser interception");
}
