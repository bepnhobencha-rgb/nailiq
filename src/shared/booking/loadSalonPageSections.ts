/**
 * Public loader for a salon's website-builder sections.
 *
 * Reads VISIBLE `salon_page_sections` (anon-readable via the public_read RLS
 * policy) ordered by `sort_order`. The public page only calls this when the
 * salon has `public_sections_enabled = true`, so a salon that hasn't opted in
 * never renders sections (and we never even query).
 *
 * `cache()` de-dupes within a single render pass.
 */
import { cache } from "react";

import { createClient } from "@/shared/lib/supabase/server";
import type { SalonSection } from "@/shared/types/salonPage";

export const loadSalonPageSections = cache(
  async (salonId: string): Promise<SalonSection[]> => {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("salon_page_sections" as never)
      .select("id, salon_id, type, title, is_visible, sort_order, content, updated_at")
      .eq("salon_id", salonId)
      .eq("is_visible", true)
      .order("sort_order", { ascending: true });

    if (error) {
      console.error("[loadSalonPageSections]", error);
      return [];
    }
    return (data ?? []) as unknown as SalonSection[];
  },
);
