/** Demo OTP table + modal — never enable in production (Vercel env). */
export function isPublicDemoOtpMode(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_OTP === "true";
}
