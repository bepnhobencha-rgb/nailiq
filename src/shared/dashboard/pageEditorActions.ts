"use server";

import { revalidatePath } from "next/cache";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";

export async function updateSectionContent(
  slug: string,
  sectionId: string,
  content: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

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
