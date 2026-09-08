import type { SuperAdminRole } from "@/shared/lib/superadmin";

/** Explicit server-side capabilities. Unknown roles never inherit a permission. */
export const SUPERADMIN_OPERATORS: readonly SuperAdminRole[] = ["founder", "ops_admin"];
export const SUPERADMIN_SALON_READERS: readonly SuperAdminRole[] = ["founder", "ops_admin", "support_admin", "billing_admin"];
export const SUPERADMIN_USER_READERS: readonly SuperAdminRole[] = ["founder", "ops_admin", "support_admin"];
