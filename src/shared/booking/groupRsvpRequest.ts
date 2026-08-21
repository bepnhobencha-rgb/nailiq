export function groupRsvpManagementIntent(
  action: "confirm" | "cancel",
  token: string,
): { action: "confirm" | "cancel"; token: string } {
  return { action, token };
}
