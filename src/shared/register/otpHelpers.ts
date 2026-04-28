import { randomInt } from "node:crypto";

export function generateSixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Compare stored OTP with user input (DB may use int / numeric and drop leading zeros). */
export function canonicalSixDigitOtp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value)).padStart(6, "0");
  }
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length >= 6) return digits.slice(-6);
  return digits.padStart(6, "0");
}
