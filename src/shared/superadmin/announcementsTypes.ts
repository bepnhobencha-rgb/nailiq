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

export const RELEASE_AUDIENCE_ROLES = [
  "owner",
  "admin",
  "receptionist",
  "senior",
  "nail_tech",
] as const;
export type ReleaseAudienceRole = (typeof RELEASE_AUDIENCE_ROLES)[number];

export type PlatformAnnouncement = {
  id: string;
  title: string;
  body: string;
  localized: {
    en: { title: string; body: string };
    vi: { title: string; body: string };
  };
  severity: AnnouncementSeverity;
  target: AnnouncementTarget;
  /** Exact salon-account roles affected by newer notices. Empty means the
   * legacy coarse `target` field controls visibility. */
  audienceRoles: ReleaseAudienceRole[];
  notificationMode: ReleaseNotificationMode;
  email: {
    requested: boolean;
    localized: {
      en: { subject: string; body: string };
      vi: { subject: string; body: string };
    };
    delivery?: {
      total: number;
      queued: number;
      sending: number;
      sent: number;
      failed: number;
      skipped: number;
      cancelled: number;
    };
  };
  /** ISO string; null when the row is still a draft. */
  publishedAt: string | null;
  /** ISO string; null when no expiry has been set. */
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function localizedAnnouncementContent(
  announcement: PlatformAnnouncement,
  language: string,
): { title: string; body: string } {
  return language === "vi"
    ? announcement.localized.vi
    : announcement.localized.en;
}

export type LoadAnnouncementsResult =
  | { ok: true; announcements: PlatformAnnouncement[] }
  | { ok: false; error: "unauthorized" | "server_error" };

export type CreateAnnouncementInput = {
  title: string;
  body: string;
  titleEn: string;
  bodyEn: string;
  titleVi: string;
  bodyVi: string;
  severity: AnnouncementSeverity;
  target: AnnouncementTarget;
  audienceRoles: ReleaseAudienceRole[];
  notificationMode: ReleaseNotificationMode;
  emailRequested: boolean;
  emailSubjectEn: string;
  emailBodyEn: string;
  emailSubjectVi: string;
  emailBodyVi: string;
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
        | "technical_language"
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

export const RELEASE_NOTIFICATION_MODES = [
  "silent",
  "in_app",
  "digest",
  "important",
] as const;
export type ReleaseNotificationMode =
  (typeof RELEASE_NOTIFICATION_MODES)[number];

export type ReleaseConciergeDraft = {
  localized: {
    en: {
      title: string;
      body: string;
      emailSubject: string;
      emailBody: string;
    };
    vi: {
      title: string;
      body: string;
      emailSubject: string;
      emailBody: string;
    };
  };
  severity: AnnouncementSeverity;
  target: AnnouncementTarget;
  audienceRoles: ReleaseAudienceRole[];
  notificationMode: ReleaseNotificationMode;
  reason: string;
};

export type DraftReleaseUpdateResult =
  | { ok: true; draft: ReleaseConciergeDraft; usedAi: boolean }
  | {
      ok: false;
      error: "unauthorized" | "invalid_payload" | "server_error";
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

export function isReleaseAudienceRole(
  value: unknown,
): value is ReleaseAudienceRole {
  return (
    typeof value === "string" &&
    (RELEASE_AUDIENCE_ROLES as readonly string[]).includes(value)
  );
}

export function isReleaseNotificationMode(
  value: unknown,
): value is ReleaseNotificationMode {
  return (
    typeof value === "string" &&
    (RELEASE_NOTIFICATION_MODES as readonly string[]).includes(value)
  );
}
