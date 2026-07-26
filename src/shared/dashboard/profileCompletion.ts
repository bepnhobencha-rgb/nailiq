export type SalonProfileCompletionInput = {
  activeServiceCount: number;
  activeStaffCount: number;
  address: string | null | undefined;
};

/**
 * Minimum operational data required before public booking can open.
 *
 * A single active staff member is intentionally sufficient: Free/trial salons
 * are capped at one staff member, so requiring two would make onboarding
 * impossible to complete.
 */
export function isSalonProfileComplete({
  activeServiceCount,
  activeStaffCount,
  address,
}: SalonProfileCompletionInput): boolean {
  return (
    activeServiceCount >= 1 &&
    activeStaffCount >= 1 &&
    (address ?? "").trim().length > 0
  );
}
