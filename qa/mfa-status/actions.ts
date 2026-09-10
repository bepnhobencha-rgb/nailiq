"use server";
import { cookies } from "next/headers";
export async function getMfaStatus() {
  const enrolled = (await cookies()).get("qa-enrolled")?.value === "yes";
  return { ok: true as const, enrolled, factorId: enrolled ? "qa-factor" : null };
}
export async function startMfaEnroll() { throw new Error("Unexpected QA enrollment mutation"); }
export async function verifyMfaEnroll() { throw new Error("Unexpected QA verification mutation"); }
export async function unenrollMfa() { throw new Error("Unexpected QA unenrollment mutation"); }
