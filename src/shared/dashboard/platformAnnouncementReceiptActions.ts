"use server";

import { revalidatePath } from "next/cache";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import {
  announcementTargetsForRole,
  isActiveAnnouncement,
} from "@/shared/dashboard/platformAnnouncements";
import {
  audienceIncludesMemberRole,
  normalizeReleaseAudienceRoles,
} from "@/shared/superadmin/releaseAudience";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ReceiptActionResult =
  | { ok: true }
  | {
      ok: false;
      error: "unauthorized" | "invalid_payload" | "not_found" | "server_error";
    };

type AnnouncementVisibilityRow = {
  target: "all" | "owners" | "staff" | "superadmins";
  audience_roles: unknown;
  published_at: string | null;
  expires_at: string | null;
};

async function writeReceipt(
  slug: string,
  announcementId: string,
  disposition: "seen" | "snoozed" | "dismissed",
): Promise<ReceiptActionResult> {
  const normalizedSlug = slug.trim();
  if (
    normalizedSlug.length === 0 ||
    normalizedSlug.length > 120 ||
    !UUID_RE.test(announcementId)
  ) {
    return { ok: false, error: "invalid_payload" };
  }

  const ctx = await getDashboardWriteClient(normalizedSlug);
  if (!ctx || !ctx.userId || ctx.kind !== "member") {
    return { ok: false, error: "unauthorized" };
  }

  const announcementResult = (await ctx.supabase
    .from("platform_announcements")
    .select("target, audience_roles, published_at, expires_at" as never)
    .eq("id", announcementId)
    .maybeSingle()) as {
    data: AnnouncementVisibilityRow | null;
    error: { code?: string } | null;
  };

  if (announcementResult.error) {
    console.error("[platform-announcement-receipt/read]", {
      code: announcementResult.error.code,
    });
    return { ok: false, error: "server_error" };
  }
  const announcement = announcementResult.data;
  if (
    !announcement ||
    !announcementTargetsForRole(ctx.role).includes(
      announcement.target as "all" | "owners" | "staff",
    ) ||
    !isActiveAnnouncement(announcement, new Date()) ||
    !audienceIncludesMemberRole(
      normalizeReleaseAudienceRoles(
        Array.isArray(announcement.audience_roles)
          ? announcement.audience_roles
          : [],
      ),
      ctx.role,
    )
  ) {
    return { ok: false, error: "not_found" };
  }

  const now = new Date().toISOString();
  const receipt = {
    announcement_id: announcementId,
    user_id: ctx.userId,
    seen_at: now,
    ...(disposition === "snoozed"
      ? {
          snoozed_until: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
        }
      : {}),
    ...(disposition === "dismissed"
      ? { dismissed_at: now, snoozed_until: null }
      : {}),
  };
  const { error } = await ctx.supabase
    .from("platform_announcement_receipts" as never)
    .upsert(receipt as never, {
      onConflict: "announcement_id,user_id",
    });
  if (error) {
    console.error("[platform-announcement-receipt/write]", {
      code: error.code,
      disposition,
    });
    return { ok: false, error: "server_error" };
  }

  revalidatePath(`/dashboard/${encodeURIComponent(normalizedSlug)}`, "layout");
  return { ok: true };
}

export async function markPlatformAnnouncementSeen(
  slug: string,
  announcementId: string,
): Promise<ReceiptActionResult> {
  return writeReceipt(slug, announcementId, "seen");
}

export async function dismissPlatformAnnouncement(
  slug: string,
  announcementId: string,
): Promise<ReceiptActionResult> {
  return writeReceipt(slug, announcementId, "dismissed");
}

export async function snoozePlatformAnnouncement(
  slug: string,
  announcementId: string,
): Promise<ReceiptActionResult> {
  return writeReceipt(slug, announcementId, "snoozed");
}

export async function updatePlatformNotificationPreference(
  slug: string,
  autoManageRoutine: boolean,
): Promise<ReceiptActionResult> {
  const normalizedSlug = slug.trim();
  if (
    normalizedSlug.length === 0 ||
    normalizedSlug.length > 120 ||
    typeof autoManageRoutine !== "boolean"
  ) {
    return { ok: false, error: "invalid_payload" };
  }

  const ctx = await getDashboardWriteClient(normalizedSlug);
  if (!ctx || !ctx.userId || ctx.kind !== "member") {
    return { ok: false, error: "unauthorized" };
  }

  const { error } = await ctx.supabase
    .from("platform_notification_preferences" as never)
    .upsert(
      {
        user_id: ctx.userId,
        auto_manage_routine: autoManageRoutine,
      } as never,
      { onConflict: "user_id" },
    );
  if (error) {
    console.error("[platform-announcement-preference/write]", {
      code: error.code,
    });
    return { ok: false, error: "server_error" };
  }

  revalidatePath(`/dashboard/${encodeURIComponent(normalizedSlug)}`, "layout");
  return { ok: true };
}
