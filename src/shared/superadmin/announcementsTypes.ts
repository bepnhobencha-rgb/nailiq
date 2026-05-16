/**
 * Type-only companion for announcementsActions.ts (Phase 1F).
 *
 * Schema reference: `platform_announcements` from migration
 * `20260510220000_superadmin_foundation_1a.sql`. Severity + target
 * are CHECK-constrained in the DB; the constant arrays here are the
 * source of truth for the admin UI rendering.
 */

export const ANNOUNCEMENT_SEVERITIES = ["info", "warning", "urgent"] as const;
export type AnnouncementSeverity = (typeof ANNOUNCEMENT_SEVERITIES)[number];

export const ANNOUNCEMENT_TARGETS = [
  "all",
  "owners",
  "staff",
  "superadmins",
] as const;
export type AnnouncementTarget = (typeof ANNOUNCEMENT_TARGETS)[number];

export type PlatformAnnouncement = {
  id: string;
  title: string;
  body: string;
  severity: AnnouncementSeverity;
  target: AnnouncementTarget;
  /** ISO string; null when the row is still a draft. */
  publishedAt: string | null;
  /** ISO string; null when no expiry has been set. */
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LoadAnnouncementsResult =
  | { ok: true; announcements: PlatformAnnouncement[] }
  | { ok: false; error: "unauthorized" | "server_error" };

export type CreateAnnouncementInput = {
  title: string;
  body: string;
  severity: AnnouncementSeverity;
  target: AnnouncementTarget;
  /** Set non-null to publish immediately; omit/null for draft. */
  publishedAt?: string | null;
  /** Optional ISO timestamp for the hide-after window. */
  expiresAt?: string | null;
};

export type CreateAnnouncementResult =
  | { ok: true; id: string }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "invalid_payload"
        | "audit_failed"
        | "server_error";
    };

export type UpdateAnnouncementInput = {
  id: string;
  /** Set `published_at` to ISO to publish; null to unpublish (back to draft). */
  publishedAt?: string | null;
};

export type UpdateAnnouncementResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "invalid_payload"
        | "not_found"
        | "audit_failed"
        | "server_error";
    };

export type DeleteAnnouncementResult =
  | { ok: true }
  | {
      ok: false;
      error: "unauthorized" | "not_found" | "audit_failed" | "server_error";
    };

export function isAnnouncementSeverity(
  value: unknown,
): value is AnnouncementSeverity {
  return (
    typeof value === "string" &&
    (ANNOUNCEMENT_SEVERITIES as readonly string[]).includes(value)
  );
}

export function isAnnouncementTarget(
  value: unknown,
): value is AnnouncementTarget {
  return (
    typeof value === "string" &&
    (ANNOUNCEMENT_TARGETS as readonly string[]).includes(value)
  );
}
