export type ReadinessStaffAccessInput = {
  id: string;
  name: string;
  jobRole: string | null;
  userId: string | null;
};

export type ReadinessMembershipInput = {
  userId: string;
  role: string;
};

export type ReadinessStaffAccess = ReadinessStaffAccessInput & {
  membershipRole: string | null;
  accessActive: boolean | null;
};

const BOOKABLE_JOB_ROLES = new Set(["owner", "senior", "nail_tech"]);
const ACTIVE_MEMBER_ROLES = new Set([
  "owner",
  "admin",
  "senior",
  "receptionist",
  "nail_tech",
]);

/**
 * A booking-only staff row needs no dashboard account. When a staff row is
 * linked to Auth, the exact tenant membership must exist with a supported
 * authorization role. The owner/admin loader supplies only same-salon rows.
 */
export function resolveReadinessStaffAccess(
  staffRows: ReadinessStaffAccessInput[],
  membershipRows: ReadinessMembershipInput[],
): { staff: ReadinessStaffAccess[]; valid: boolean } {
  const memberships = new Map(
    membershipRows
      .filter((row) => ACTIVE_MEMBER_ROLES.has(row.role))
      .map((row) => [row.userId, row.role]),
  );
  const staff = staffRows.map((row) => {
    if (row.userId === null) {
      return { ...row, membershipRole: null, accessActive: null };
    }
    const membershipRole = memberships.get(row.userId) ?? null;
    return {
      ...row,
      membershipRole,
      accessActive: membershipRole !== null,
    };
  });
  return {
    staff,
    valid: staff.every(
      (row) =>
        row.jobRole !== null &&
        BOOKABLE_JOB_ROLES.has(row.jobRole) &&
        (row.userId === null || row.accessActive === true),
    ),
  };
}
