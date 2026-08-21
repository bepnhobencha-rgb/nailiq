"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { requireActiveSuperAdminSession } from "@/shared/auth/requireActiveSuperAdminSession";
import {
  isAnnouncementSeverity,
  isAnnouncementTarget,
  isReleaseNotificationMode,
  type AnnouncementSeverity,
  type AnnouncementTarget,
  type CreateAnnouncementInput,
  type CreateAnnouncementResult,
  type DeleteAnnouncementResult,
  type LoadAnnouncementsResult,
  type PlatformAnnouncement,
  type UpdateAnnouncementInput,
  type UpdateAnnouncementResult,
} from "@/shared/superadmin/announcementsTypes";
import {
  containsTechnicalReleaseLanguage,
  legacyTargetForAudience,
  normalizeReleaseAudienceRoles,
} from "@/shared/superadmin/releaseAudience";

/**
 * Phase 1F — platform announcements admin server actions.
 *
 * Mirrors `superadminActions.ts` patterns: explicit superadmin
 * caller check, service-role client for writes, audit row on every
 * mutation (action ∈ create | publish | unpublish | delete).
 *
 * Per `PERMISSION_MATRIX §8.6` the announcements admin surface is
 * reachable by founder + ops_admin. The page itself runs the role
 * gate (it's a server component); these actions double-check.
 */

const ADMIN_ROLES_FOR_ANNOUNCEMENTS = new Set(["founder", "ops_admin"]);
const TITLE_MAX_LEN = 120;
const BODY_MAX_LEN = 2_000;
const EMAIL_SUBJECT_MAX_LEN = 160;
const EMAIL_BODY_MAX_LEN = 4_000;

type AdminCaller = { userId: string; role: string };

async function requireAnnouncementsAdmin(): Promise<AdminCaller | null> {
  const access = await requireActiveSuperAdminSession();
  if (!access.ok) return null;
  const { role, user } = access;
  if (!role || !ADMIN_ROLES_FOR_ANNOUNCEMENTS.has(role)) return null;
  return { userId: user.id, role };
}

async function writeAuditRow(
  caller: AdminCaller,
  action: string,
  targetId: string | null,
  payload: Record<string, unknown>,
): Promise<boolean> {
  try {
    const admin = createServiceRoleClient();
    const { error } = await admin.from("superadmin_audit_logs").insert(
      {
        actor_user_id: caller.userId,
        actor_role: caller.role,
        action,
        target_kind: "announcement",
        target_id: targetId,
        after_jsonb: payload,
      } as never,
    );
    if (error) {
      console.error("[announcements/audit] insert", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[announcements/audit] unexpected", e);
    return false;
  }
}

function mapRow(row: {
  id: string;
  title: string;
  body: string;
  title_en: string | null;
  body_en: string | null;
  title_vi: string | null;
  body_vi: string | null;
  audience_roles: unknown;
  notification_mode: string;
  email_requested: boolean;
  email_subject_en: string | null;
  email_body_en: string | null;
  email_subject_vi: string | null;
  email_body_vi: string | null;
  severity: string;
  target: string;
  published_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}, delivery?: PlatformAnnouncement["email"]["delivery"]): PlatformAnnouncement {
  const titleEn = row.title_en?.trim() || row.title;
  const bodyEn = row.body_en?.trim() || row.body;
  const titleVi = row.title_vi?.trim() || titleEn;
  const bodyVi = row.body_vi?.trim() || bodyEn;
  const audienceRoles = normalizeReleaseAudienceRoles(
    Array.isArray(row.audience_roles) ? row.audience_roles : [],
  );
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    localized: {
      en: { title: titleEn, body: bodyEn },
      vi: { title: titleVi, body: bodyVi },
    },
    severity: (isAnnouncementSeverity(row.severity)
      ? row.severity
      : "info") as AnnouncementSeverity,
    target: (isAnnouncementTarget(row.target)
      ? row.target
      : "all") as AnnouncementTarget,
    audienceRoles,
    notificationMode: isReleaseNotificationMode(row.notification_mode)
      ? row.notification_mode
      : "in_app",
    email: {
      requested: row.email_requested === true,
      delivery,
      localized: {
        en: {
          subject: row.email_subject_en?.trim() || titleEn,
          body: row.email_body_en?.trim() || bodyEn,
        },
        vi: {
          subject: row.email_subject_vi?.trim() || titleVi,
          body: row.email_body_vi?.trim() || bodyVi,
        },
      },
    },
    publishedAt: row.published_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function loadAnnouncements(): Promise<LoadAnnouncementsResult> {
  const caller = await requireAnnouncementsAdmin();
  if (!caller) return { ok: false, error: "unauthorized" };

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[announcements/load] service role", e);
    return { ok: false, error: "server_error" };
  }

  const { data, error } = (await admin
    .from("platform_announcements")
    .select(
      "id, title, body, title_en, body_en, title_vi, body_vi, audience_roles, notification_mode, email_requested, email_subject_en, email_body_en, email_subject_vi, email_body_vi, severity, target, published_at, expires_at, created_at, updated_at" as never,
    )
    .order("created_at", { ascending: false })) as {
    data:
      | Array<{
          id: string;
          title: string;
          body: string;
          title_en: string | null;
          body_en: string | null;
          title_vi: string | null;
          body_vi: string | null;
          audience_roles: unknown;
          notification_mode: string;
          email_requested: boolean;
          email_subject_en: string | null;
          email_body_en: string | null;
          email_subject_vi: string | null;
          email_body_vi: string | null;
          severity: string;
          target: string;
          published_at: string | null;
          expires_at: string | null;
          created_at: string;
          updated_at: string;
        }>
      | null;
    error: unknown;
  };

  if (error) {
    console.error("[announcements/load] query", error);
    return { ok: false, error: "server_error" };
  }

  const announcementRows = data ?? [];
  const ids = announcementRows.map((row) => row.id);
  const deliveryByAnnouncement = new Map<
    string,
    NonNullable<PlatformAnnouncement["email"]["delivery"]>
  >();
  if (ids.length > 0) {
    const deliveries = (await admin
      .from("platform_announcement_deliveries" as never)
      .select("announcement_id, status" as never)
      .in("announcement_id" as never, ids)) as {
      data: Array<{ announcement_id: string; status: string }> | null;
      error: unknown;
    };
    if (deliveries.error) {
      console.error("[announcements/load] delivery summary", deliveries.error);
      return { ok: false, error: "server_error" };
    }
    for (const row of deliveries.data ?? []) {
      const current = deliveryByAnnouncement.get(row.announcement_id) ?? {
        total: 0,
        queued: 0,
        sending: 0,
        sent: 0,
        failed: 0,
        skipped: 0,
        cancelled: 0,
      };
      current.total += 1;
      if (row.status in current && row.status !== "total") {
        current[row.status as Exclude<keyof typeof current, "total">] += 1;
      }
      deliveryByAnnouncement.set(row.announcement_id, current);
    }
  }

  return {
    ok: true,
    announcements: announcementRows.map((row) =>
      mapRow(row, deliveryByAnnouncement.get(row.id)),
    ),
  };
}

export async function createAnnouncement(
  input: CreateAnnouncementInput,
): Promise<CreateAnnouncementResult> {
  const caller = await requireAnnouncementsAdmin();
  if (!caller) return { ok: false, error: "unauthorized" };

  const title = (input.title ?? "").trim();
  const body = (input.body ?? "").trim();
  const titleEn = (input.titleEn ?? "").trim();
  const bodyEn = (input.bodyEn ?? "").trim();
  const titleVi = (input.titleVi ?? "").trim();
  const bodyVi = (input.bodyVi ?? "").trim();
  const emailSubjectEn = (input.emailSubjectEn ?? "").trim();
  const emailBodyEn = (input.emailBodyEn ?? "").trim();
  const emailSubjectVi = (input.emailSubjectVi ?? "").trim();
  const emailBodyVi = (input.emailBodyVi ?? "").trim();
  const audienceRoles = normalizeReleaseAudienceRoles(input.audienceRoles ?? []);
  if (title.length === 0 || title.length > TITLE_MAX_LEN) {
    return { ok: false, error: "invalid_payload" };
  }
  if (body.length === 0 || body.length > BODY_MAX_LEN) {
    return { ok: false, error: "invalid_payload" };
  }
  if (
    titleEn.length === 0 ||
    titleEn.length > TITLE_MAX_LEN ||
    bodyEn.length === 0 ||
    bodyEn.length > BODY_MAX_LEN ||
    titleVi.length === 0 ||
    titleVi.length > TITLE_MAX_LEN ||
    bodyVi.length === 0 ||
    bodyVi.length > BODY_MAX_LEN
  ) {
    return { ok: false, error: "invalid_payload" };
  }
  if (!isAnnouncementSeverity(input.severity)) {
    return { ok: false, error: "invalid_payload" };
  }
  if (!isAnnouncementTarget(input.target) || audienceRoles.length === 0) {
    return { ok: false, error: "invalid_payload" };
  }
  if (!isReleaseNotificationMode(input.notificationMode)) {
    return { ok: false, error: "invalid_payload" };
  }
  if (
    emailSubjectEn.length === 0 ||
    emailSubjectEn.length > EMAIL_SUBJECT_MAX_LEN ||
    emailBodyEn.length === 0 ||
    emailBodyEn.length > EMAIL_BODY_MAX_LEN ||
    emailSubjectVi.length === 0 ||
    emailSubjectVi.length > EMAIL_SUBJECT_MAX_LEN ||
    emailBodyVi.length === 0 ||
    emailBodyVi.length > EMAIL_BODY_MAX_LEN
  ) {
    return { ok: false, error: "invalid_payload" };
  }
  if (input.emailRequested && input.notificationMode !== "important") {
    return { ok: false, error: "invalid_payload" };
  }
  if (
    [
      titleEn,
      bodyEn,
      titleVi,
      bodyVi,
      emailSubjectEn,
      emailBodyEn,
      emailSubjectVi,
      emailBodyVi,
    ].some(containsTechnicalReleaseLanguage)
  ) {
    return { ok: false, error: "technical_language" };
  }

  // Sanity: parseable ISO timestamps if provided.
  const publishedAt =
    input.publishedAt === undefined || input.publishedAt === null
      ? null
      : new Date(input.publishedAt);
  if (publishedAt && Number.isNaN(publishedAt.getTime())) {
    return { ok: false, error: "invalid_payload" };
  }
  const expiresAt =
    input.expiresAt === undefined || input.expiresAt === null
      ? null
      : new Date(input.expiresAt);
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    return { ok: false, error: "invalid_payload" };
  }

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[announcements/create] service role", e);
    return { ok: false, error: "server_error" };
  }

  const target = legacyTargetForAudience(audienceRoles);
  const publishAfterQueue = Boolean(publishedAt && input.emailRequested);
  const insertRes = (await admin
    .from("platform_announcements")
    .insert(
      {
        title,
        body,
        title_en: titleEn,
        body_en: bodyEn,
        title_vi: titleVi,
        body_vi: bodyVi,
        audience_roles: audienceRoles,
        notification_mode: input.notificationMode,
        email_requested: input.emailRequested,
        email_subject_en: emailSubjectEn,
        email_body_en: emailBodyEn,
        email_subject_vi: emailSubjectVi,
        email_body_vi: emailBodyVi,
        severity: input.severity,
        target,
        published_at:
          publishedAt && !publishAfterQueue ? publishedAt.toISOString() : null,
        expires_at: expiresAt ? expiresAt.toISOString() : null,
        created_by: caller.userId,
      } as never,
    )
    .select("id")
    .maybeSingle()) as {
    data: { id: string } | null;
    error: unknown;
  };

  if (insertRes.error || !insertRes.data?.id) {
    console.error("[announcements/create] insert", insertRes.error);
    return { ok: false, error: "server_error" };
  }

  let preAuditedEmailPublish = false;
  if (publishAfterQueue) {
    preAuditedEmailPublish = await writeAuditRow(
      caller,
      "announcement_create_and_email_publish_approved",
      insertRes.data.id,
      {
        localized_languages: ["en", "vi"],
        severity: input.severity,
        target,
        audience_roles: audienceRoles,
        notification_mode: input.notificationMode,
        email_requested: true,
        requested_publish_at: publishedAt!.toISOString(),
      },
    );
    if (!preAuditedEmailPublish) {
      return { ok: false, error: "audit_failed" };
    }
    const queued = await admin.rpc(
      "queue_platform_announcement_deliveries" as never,
      { p_announcement_id: insertRes.data.id } as never,
    );
    if (queued.error) {
      console.error("[announcements/create] queue email", queued.error);
      return { ok: false, error: "server_error" };
    }
    const published = await admin
      .from("platform_announcements")
      .update({ published_at: publishedAt!.toISOString() } as never)
      .eq("id", insertRes.data.id);
    if (published.error) {
      console.error("[announcements/create] publish after queue", published.error);
      return { ok: false, error: "server_error" };
    }
  }

  if (!preAuditedEmailPublish) {
    const audited = await writeAuditRow(
      caller,
      "announcement_create",
      insertRes.data.id,
      {
        title,
        localized_languages: ["en", "vi"],
        severity: input.severity,
        target,
        audience_roles: audienceRoles,
        notification_mode: input.notificationMode,
        email_requested: input.emailRequested,
        published_at: publishedAt ? publishedAt.toISOString() : null,
      },
    );
    if (!audited) {
      return { ok: false, error: "audit_failed" };
    }
  }

  return { ok: true, id: insertRes.data.id };
}

export async function updateAnnouncementPublish(
  input: UpdateAnnouncementInput,
): Promise<UpdateAnnouncementResult> {
  const caller = await requireAnnouncementsAdmin();
  if (!caller) return { ok: false, error: "unauthorized" };

  const id = (input.id ?? "").trim();
  if (!id) return { ok: false, error: "invalid_payload" };

  const publishedAt =
    input.publishedAt === undefined ? undefined : input.publishedAt;

  if (publishedAt === undefined) {
    return { ok: false, error: "invalid_payload" };
  }

  const parsed =
    publishedAt === null
      ? null
      : new Date(publishedAt);
  if (parsed && Number.isNaN(parsed.getTime())) {
    return { ok: false, error: "invalid_payload" };
  }

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[announcements/update] service role", e);
    return { ok: false, error: "server_error" };
  }

  const updateRes = (await admin
    .from("platform_announcements")
    .select("id, email_requested")
    .eq("id", id)
    .maybeSingle()) as {
    data: { id: string; email_requested: boolean } | null;
    error: unknown;
  };

  if (updateRes.error) {
    console.error("[announcements/update] load", updateRes.error);
    return { ok: false, error: "server_error" };
  }
  if (!updateRes.data?.id) {
    return { ok: false, error: "not_found" };
  }

  let preAuditedEmailPublish = false;
  if (parsed && updateRes.data.email_requested) {
    preAuditedEmailPublish = await writeAuditRow(
      caller,
      "announcement_publish_email_approved",
      id,
      { requested_publish_at: parsed.toISOString(), email_requested: true },
    );
    if (!preAuditedEmailPublish) {
      return { ok: false, error: "audit_failed" };
    }
    const queued = await admin.rpc(
      "queue_platform_announcement_deliveries" as never,
      { p_announcement_id: id } as never,
    );
    if (queued.error) {
      console.error("[announcements/update] queue email", queued.error);
      return { ok: false, error: "server_error" };
    }
  }

  const saved = await admin
    .from("platform_announcements")
    .update({ published_at: parsed ? parsed.toISOString() : null } as never)
    .eq("id", id);
  if (saved.error) {
    console.error("[announcements/update] save", saved.error);
    return { ok: false, error: "server_error" };
  }
  if (!parsed) {
    const cancelled = await admin
      .from("platform_announcement_deliveries" as never)
      .update({ status: "cancelled", updated_at: new Date().toISOString() } as never)
      .eq("announcement_id" as never, id)
      .in("status" as never, ["queued", "failed"]);
    if (cancelled.error) {
      console.error("[announcements/update] cancel queued email", cancelled.error);
    }
  }

  if (!preAuditedEmailPublish) {
    const audited = await writeAuditRow(
      caller,
      parsed ? "announcement_publish" : "announcement_unpublish",
      id,
      {
        published_at: parsed ? parsed.toISOString() : null,
      },
    );
    if (!audited) {
      return { ok: false, error: "audit_failed" };
    }
  }

  return { ok: true };
}

export async function deleteAnnouncement(
  id: string,
): Promise<DeleteAnnouncementResult> {
  const caller = await requireAnnouncementsAdmin();
  if (!caller) return { ok: false, error: "unauthorized" };

  const trimmed = (id ?? "").trim();
  if (!trimmed) return { ok: false, error: "not_found" };

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[announcements/delete] service role", e);
    return { ok: false, error: "server_error" };
  }

  // Hard delete — the audit row preserves the trail. V1 keeps it
  // simple; if announcements pile up history we can later soft-delete.
  const deleteRes = (await admin
    .from("platform_announcements")
    .delete()
    .eq("id", trimmed)
    .select("id")
    .maybeSingle()) as {
    data: { id: string } | null;
    error: unknown;
  };

  if (deleteRes.error) {
    console.error("[announcements/delete] delete", deleteRes.error);
    return { ok: false, error: "server_error" };
  }
  if (!deleteRes.data?.id) {
    return { ok: false, error: "not_found" };
  }

  const audited = await writeAuditRow(caller, "announcement_delete", trimmed, {
    deleted_at: new Date().toISOString(),
  });
  if (!audited) {
    return { ok: false, error: "audit_failed" };
  }

  return { ok: true };
}
