export type StaffOffboardingContactPlan =
  | "notification_selected"
  | "manual_contact"
  | "not_required";

type ContactPlanInput = {
  customerRequestedStaff: boolean;
  hasEmail: boolean;
  hasPhone: boolean;
  notifyEmail: boolean;
  notifySms: boolean;
  manualContactConfirmed: boolean;
};

/**
 * A named-provider request cannot silently become an ordinary reassignment.
 * Return null until the salon has a deliverable notice channel or confirms a
 * direct conversation with the guest.
 */
export function resolveStaffOffboardingContactPlan(
  input: ContactPlanInput,
): StaffOffboardingContactPlan | null {
  const hasSelectedNoticeChannel =
    (input.notifyEmail && input.hasEmail) ||
    (input.notifySms && input.hasPhone);

  if (hasSelectedNoticeChannel) return "notification_selected";
  if (!input.customerRequestedStaff) return "not_required";
  if (input.manualContactConfirmed) return "manual_contact";
  return null;
}
