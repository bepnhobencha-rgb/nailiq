"use server";

import { revalidatePath } from "next/cache";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Owner-only: toggle whether the salon's visible website-builder sections
 * render on the public booking page (`salons.public_sections_enabled`).
 */
export async function updatePublicSectionsEnabled(
  slug: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (ctx.role !== "owner") return { ok: false, error: "forbidden" };

  const { error } = await ctx.supabase
    .from("salons")
    .update({ public_sections_enabled: enabled } as never)
    .eq("id", ctx.salon.id);

  if (error) {
    console.error("[updatePublicSectionsEnabled]", error);
    return { ok: false, error: error.message };
  }
  revalidatePath(`/dashboard/${slug}/settings/my-page`);
  return { ok: true };
}

export async function updateSectionContent(
  slug: string,
  sectionId: string,
  content: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (ctx.role !== "owner") return { ok: false, error: "forbidden" };

  const { error } = await ctx.supabase
    .from("salon_page_sections" as never)
    .update({ content } as never)
    .eq("id", sectionId)
    .eq("salon_id", ctx.salon.id);

  if (error) {
    console.error("[updateSectionContent]", error);
    return { ok: false, error: error.message };
  }

  revalidatePath(`/dashboard/${slug}/settings/my-page`);
  return { ok: true };
}

export async function toggleSectionVisibility(
  slug: string,
  sectionId: string,
  isVisible: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (ctx.role !== "owner") return { ok: false, error: "forbidden" };

  const { error } = await ctx.supabase
    .from("salon_page_sections" as never)
    .update({ is_visible: isVisible } as never)
    .eq("id", sectionId)
    .eq("salon_id", ctx.salon.id);

  if (error) {
    console.error("[toggleSectionVisibility]", error);
    return { ok: false, error: error.message };
  }

  return { ok: true };
}

export async function updateSectionOrder(
  slug: string,
  sections: { id: string; sort_order: number }[],
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  for (const { id, sort_order } of sections) {
    const { error } = await ctx.supabase
      .from("salon_page_sections" as never)
      .update({ sort_order } as never)
      .eq("id", id)
      .eq("salon_id", ctx.salon.id);

    if (error) {
      console.error("[updateSectionOrder]", error);
      return { ok: false, error: error.message };
    }
  }

  return { ok: true };
}

export async function uploadSectionImage(
  slug: string,
  formData: FormData,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  const file = formData.get("file") as File | null;
  const type = (formData.get("type") as string | null) ?? "section";

  if (!file || file.size === 0) return { ok: false, error: "no_file" };
  if (file.size > 5 * 1024 * 1024) return { ok: false, error: "file_too_large" };

  const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (!allowed.includes(file.type)) return { ok: false, error: "invalid_type" };

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "jpg";
  const path = `${ctx.salon.id}/sections/${type}-${Date.now()}.${ext}`;

  const db = createServiceRoleClient();
  const { error } = await db.storage
    .from("salon-imports")
    .upload(path, file, { contentType: file.type, upsert: true });

  if (error) {
    console.error("[uploadSectionImage]", error);
    return { ok: false, error: error.message };
  }

  const { data } = db.storage.from("salon-imports").getPublicUrl(path);
  return { ok: true, url: data.publicUrl };
}
