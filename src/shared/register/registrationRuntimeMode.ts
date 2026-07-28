/**
 * DEMO_OTP is also enabled in local and CI E2E environments. A real Supabase
 * session therefore takes precedence; demo registration is only for an
 * anonymous visitor.
 */
export function shouldUseAnonymousDemoRegistration(
  isDemoRuntime: boolean,
  hasAuthenticatedUser: boolean,
): boolean {
  return isDemoRuntime && !hasAuthenticatedUser;
}
