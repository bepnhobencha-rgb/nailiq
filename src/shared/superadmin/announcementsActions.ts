"use server";

import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getSuperAdminRole } from "@/shared/lib/superadmin";
import {
  isAnnouncementSeverity,
  isAnnouncementTarget,
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

type AdminCaller = { userId: string; role: string };

async function requireAnnouncementsAdmin(): Promise<AdminCaller | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const role = await getSuperAdminRole(user.id);
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
  severity: string;
  target: string;
  published_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}): PlatformAnnouncement {
  const titleEn = row.title_en?.trim() || row.title;
  const bodyEn = row.body_en?.trim() || row.body;
  const titleVi = row.title_vi?.trim() || titleEn;
  const bodyVi = row.body_vi?.trim() || bodyEn;
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
      "id, title, body, title_en, body_en, title_vi, body_vi, severity, target, published_at, expires_at, created_at, updated_at" as never,
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

  return { ok: true, announcements: (data ?? []).map(mapRow) };
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
  if (!isAnnouncementTarget(input.target)) {
    return { ok: false, error: "invalid_payload" };
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
        severity: input.severity,
        target: input.target,
        published_at: publishedAt ? publishedAt.toISOString() : null,
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

  const audited = await writeAuditRow(
    caller,
    "announcement_create",
    insertRes.data.id,
    {
      title,
      localized_languages: ["en", "vi"],
      severity: input.severity,
      target: input.target,
      published_at: publishedAt ? publishedAt.toISOString() : null,
    },
  );
  if (!audited) {
    return { ok: false, error: "audit_failed" };
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
    .update(
      {
        published_at: parsed ? parsed.toISOString() : null,
      } as never,
    )
    .eq("id", id)
    .select("id")
    .maybeSingle()) as {
    data: { id: string } | null;
    error: unknown;
  };

  if (updateRes.error) {
    console.error("[announcements/update] update", updateRes.error);
    return { ok: false, error: "server_error" };
  }
  if (!updateRes.data?.id) {
    return { ok: false, error: "not_found" };
  }

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
