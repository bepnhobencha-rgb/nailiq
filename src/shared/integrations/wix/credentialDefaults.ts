/**
 * Saving credentials must not silently activate outbound/inbound sync. Preserve
 * an existing explicit choice; a brand-new integration starts disabled until
 * the owner separately enables it in the UI.
 */
export function resolveWixEnabledOnCredentialSave(
  existingEnabled: unknown,
  requestedEnabled: unknown,
): boolean {
  if (typeof requestedEnabled === "boolean") return requestedEnabled;
  return existingEnabled === true;
}
