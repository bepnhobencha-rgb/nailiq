import type { SalonMemberRole } from "@/shared/lib/salonMemberRole";
import {
  RELEASE_AUDIENCE_ROLES,
  type AnnouncementTarget,
  type ReleaseAudienceRole,
} from "@/shared/superadmin/announcementsTypes";

export const RELEASE_AUDIENCE_LABELS: Record<ReleaseAudienceRole, string> = {
  owner: "Salon owners",
  admin: "Admins",
  receptionist: "Receptionists",
  senior: "Senior staff",
  nail_tech: "Nail technicians",
};

export function normalizeReleaseAudienceRoles(
  values: readonly unknown[],
): ReleaseAudienceRole[] {
  const allowed = new Set<string>(RELEASE_AUDIENCE_ROLES);
  return RELEASE_AUDIENCE_ROLES.filter((role) =>
    values.some((value) => typeof value === "string" && allowed.has(value) && value === role),
  );
}

export function legacyTargetForAudience(
  roles: readonly ReleaseAudienceRole[],
): AnnouncementTarget {
  const normalized = normalizeReleaseAudienceRoles(roles);
  if (normalized.length === 2 && normalized.includes("owner") && normalized.includes("admin")) {
    return "owners";
  }
  if (
    normalized.length > 0 &&
    normalized.every((role) =>
      role === "receptionist" || role === "senior" || role === "nail_tech",
    )
  ) {
    return "staff";
  }
  return "all";
}

export function audienceIncludesMemberRole(
  audienceRoles: readonly ReleaseAudienceRole[],
  memberRole: SalonMemberRole,
): boolean {
  return audienceRoles.length === 0 || audienceRoles.includes(memberRole);
}

/**
 * Product notices must describe operator outcomes, not internal engineering.
 * This is deliberately conservative: Superadmin can rewrite the sentence in
 * normal salon language before publishing.
 */
const TECHNICAL_COPY_PATTERNS = [
  /\bcommit\b/i,
  /\bpull request\b/i,
  /\bPR\s*#?\d+/i,
  /\bCI\b/,
  /\bdeploy(?:ment|ed|ing)?\b/i,
  /\bproduction\b/i,
  /\bAPI endpoint\b/i,
  /\bdatabase migration\b/i,
  /\b(?:React|TypeScript|JavaScript|Supabase|Vercel)\b/i,
  /\b(?:npm|pnpm|yarn)\s+(?:run|test|build|install)\b/i,
  /(?:^|\s)(?:src|app|pages|supabase)\/[\w./-]+/i,
  /\b[0-9a-f]{8,64}\b/i,
  /\b[\w-]+\.(?:ts|tsx|js|jsx|sql)\b/i,
];

export function containsTechnicalReleaseLanguage(value: string): boolean {
  return TECHNICAL_COPY_PATTERNS.some((pattern) => pattern.test(value));
}
