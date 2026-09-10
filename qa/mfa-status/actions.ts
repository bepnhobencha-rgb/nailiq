"use server";
import { cookies } from "next/headers";
export async function getMfaStatus() {
  const enrolled = (await cookies()).get("qa-enrolled")?.value === "yes";
  return { ok: true as const, enrolled, factorId: enrolled ? "qa-factor" : null };
}
async function enrollmentFault(unavailable: string) {
  const fault = (await cookies()).get("qa-enrollment-fault")?.value;
  if (fault === "throw") throw new Error("private Auth detail");
  return fault ? { ok: false as const, error: fault === "unavailable" ? unavailable : fault } : null;
}
export async function startMfaEnroll() {
  const fault = await enrollmentFault("enroll_failed"); if (fault) return fault;
  return { ok: true as const, factorId: "qa-factor", qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="176" height="176"><rect width="176" height="176" fill="black"/></svg>', secret: "FAKE-QA-SECRET-ONLY" };
}
export async function verifyMfaEnroll() {
  const fault = await enrollmentFault("verification_unavailable"); if (fault) return fault;
  (await cookies()).set("qa-enrolled", "yes");
  return { ok: true as const };
}
export async function unenrollMfa() {
  const fault = await enrollmentFault("unenroll_failed"); if (fault) return fault;
  (await cookies()).set("qa-enrolled", "no");
  return { ok: true as const };
}
export async function verifyMfaChallenge() {
  const fault = (await cookies()).get("qa-challenge-fault")?.value;
  if (fault === "throw") throw new Error("private Auth detail");
  if (fault) return { ok: false as const, error: fault };
  return { ok: true as const };
}
