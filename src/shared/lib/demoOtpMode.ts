/** Trims stray quotes/spaces — Vercel env values sometimes include wrapping quotes */
export function normalizeDemoOtpEnv(raw: string | undefined): boolean {
  if (raw == null) return false;
  const v = raw
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .trim()
    .toLowerCase();
  return v === "true" || v === "1";
}

/**
 * Server / Server Action: DEMO_OTP reads at runtime (toggle on Vercel without rebuild).
 * NEXT_PUBLIC_DEMO_OTP is inlined at build — requires a redeploy after changing it.
 */
export function isDemoOtpRuntime(): boolean {
  return (
    normalizeDemoOtpEnv(process.env.DEMO_OTP) ||
    normalizeDemoOtpEnv(process.env.NEXT_PUBLIC_DEMO_OTP)
  );
}

