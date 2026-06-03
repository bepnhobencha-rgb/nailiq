import { RegisterPageClient } from "@/app/register/RegisterPageClient";

export const dynamic = "force-dynamic";

/**
 * /register page — unified sign-in/sign-up surface.
 *
 * Auth guards are now centralized in `src/middleware.ts`:
 * - Logged-in user with salon → redirected to /dashboard by middleware
 * - Logged-in user WITHOUT salon → redirected to /register/setup by middleware
 * - Unauthenticated user → allowed (see both sign-in + sign-up options)
 *
 * This page only renders for unauthenticated users.
 */
export default function RegisterPage() {
  return <RegisterPageClient />;
}
