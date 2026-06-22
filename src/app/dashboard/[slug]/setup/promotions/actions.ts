"use server";

import { createClient } from "@/shared/lib/supabase/server";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { revalidatePath } from "next/cache";
import { z } from "zod";

const PromotionServiceInput = z.object({
  service_id: z.string().uuid(),
  discount_type: z.enum(["fixed_price", "percent", "amount"]).nullable().optional(),
  discount_value: z.number().int().min(0).nullable().optional(),
});

const PromotionInput = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().nullable(),
  starts_at: z.string().min(1),
  ends_at: z.string().min(1),
  days_of_week: z.array(z.number().int().min(0).max(6)).optional().nullable(),
  time_start: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  time_end: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  discount_type: z.enum(["fixed_price", "percent", "amount"]),
  discount_value: z.number().int().min(0),
  applies_to: z.enum(["all", "specific"]),
  active: z.boolean().optional().default(true),
  services: z.array(PromotionServiceInput).optional().default([]),
});

export type PromotionFormData = z.infer<typeof PromotionInput>;

export async function createPromotionAction(
  slug: string,
  formData: PromotionFormData,
): Promise<{ error?: string; id?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { error: "unauthorized" };
  if (ctx.role !== "owner" && ctx.role !== "admin") return { error: "unauthorized" };

  const parsed = PromotionInput.safeParse(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "invalid_input" };
  const d = parsed.data;

  const supabase = await createClient();

  const { data: promo, error: promoErr } = await supabase
    .from("promotions" as never)
    .insert({
      salon_id: ctx.salon.id,
      name: d.name,
      description: d.description ?? null,
      starts_at: d.starts_at,
      ends_at: d.ends_at,
      days_of_week: d.days_of_week?.length ? d.days_of_week : null,
      time_start: d.time_start ?? null,
      time_end: d.time_end ?? null,
      discount_type: d.discount_type,
      discount_value: d.discount_value,
      applies_to: d.applies_to,
      active: d.active,
    } as never)
    .select("id")
    .maybeSingle();

  if (promoErr) return { error: promoErr.message };
  const promoId = (promo as { id: string } | null)?.id;
  if (!promoId) return { error: "insert_failed" };

  if (d.services.length > 0) {
    const svcRows = d.services
      .filter((s) => s.service_id)
      .map((s) => ({
        promotion_id: promoId,
        service_id: s.service_id,
        discount_type: s.discount_type ?? null,
        discount_value: s.discount_value ?? null,
      }));
    if (svcRows.length > 0) {
      const { error: svcErr } = await supabase
        .from("promotion_services" as never)
        .insert(svcRows as never);
      if (svcErr) return { error: svcErr.message };
    }
  }

  revalidatePath(`/dashboard/${slug}/setup/promotions`);
  return { id: promoId };
}

export async function updatePromotionAction(
  slug: string,
  promoId: string,
  formData: PromotionFormData,
): Promise<{ error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { error: "unauthorized" };
  if (ctx.role !== "owner" && ctx.role !== "admin") return { error: "unauthorized" };

  const parsed = PromotionInput.safeParse(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "invalid_input" };
  const d = parsed.data;

  const supabase = await createClient();

  const { error: updateErr } = await supabase
    .from("promotions" as never)
    .update({
      name: d.name,
      description: d.description ?? null,
      starts_at: d.starts_at,
      ends_at: d.ends_at,
      days_of_week: d.days_of_week?.length ? d.days_of_week : null,
      time_start: d.time_start ?? null,
      time_end: d.time_end ?? null,
      discount_type: d.discount_type,
      discount_value: d.discount_value,
      applies_to: d.applies_to,
      active: d.active,
    } as never)
    .eq("id" as never, promoId)
    .eq("salon_id" as never, ctx.salon.id);

  if (updateErr) return { error: updateErr.message };

  // Replace per-service rules atomically
  await supabase
    .from("promotion_services" as never)
    .delete()
    .eq("promotion_id" as never, promoId);

  if (d.services.length > 0) {
    const svcRows = d.services
      .filter((s) => s.service_id)
      .map((s) => ({
        promotion_id: promoId,
        service_id: s.service_id,
        discount_type: s.discount_type ?? null,
        discount_value: s.discount_value ?? null,
      }));
    if (svcRows.length > 0) {
      await supabase.from("promotion_services" as never).insert(svcRows as never);
    }
  }

  revalidatePath(`/dashboard/${slug}/setup/promotions`);
  return {};
}

export async function togglePromotionActiveAction(
  slug: string,
  promoId: string,
  active: boolean,
): Promise<{ error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { error: "unauthorized" };
  if (ctx.role !== "owner" && ctx.role !== "admin") return { error: "unauthorized" };

  const supabase = await createClient();
  const { error } = await supabase
    .from("promotions" as never)
    .update({ active } as never)
    .eq("id" as never, promoId)
    .eq("salon_id" as never, ctx.salon.id);

  if (error) return { error: error.message };
  revalidatePath(`/dashboard/${slug}/setup/promotions`);
  return {};
}

export async function deletePromotionAction(
  slug: string,
  promoId: string,
): Promise<{ error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { error: "unauthorized" };
  if (ctx.role !== "owner" && ctx.role !== "admin") return { error: "unauthorized" };

  const supabase = await createClient();
  const { error } = await supabase
    .from("promotions" as never)
    .delete()
    .eq("id" as never, promoId)
    .eq("salon_id" as never, ctx.salon.id);

  if (error) return { error: error.message };
  revalidatePath(`/dashboard/${slug}/setup/promotions`);
  return {};
}

export type PromotionRow = {
  id: string;
  name: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
  discount_type: string;
  discount_value: number;
  applies_to: string;
  active: boolean;
  days_of_week: number[] | null;
  time_start: string | null;
  time_end: string | null;
};

export type PromotionServiceRow = {
  promotion_id: string;
  service_id: string;
  discount_type: string | null;
  discount_value: number | null;
};

export async function loadPromotionsData(slug: string): Promise<{
  promos: PromotionRow[];
  svcRules: PromotionServiceRow[];
  services: { id: string; name: string; price_cents: number | null }[];
} | null> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return null;
  if (ctx.role !== "owner" && ctx.role !== "admin") return null;

  const supabase = await createClient();

  const { data: promos } = await supabase
    .from("promotions" as never)
    .select("id, name, description, starts_at, ends_at, discount_type, discount_value, applies_to, active, days_of_week, time_start, time_end")
    .eq("salon_id" as never, ctx.salon.id)
    .order("starts_at" as never, { ascending: false });

  const promoList = (promos ?? []) as PromotionRow[];
  let svcRules: PromotionServiceRow[] = [];

  if (promoList.length > 0) {
    const { data: rules } = await supabase
      .from("promotion_services" as never)
      .select("promotion_id, service_id, discount_type, discount_value")
      .in("promotion_id" as never, promoList.map((p) => p.id));
    svcRules = (rules ?? []) as PromotionServiceRow[];
  }

  const { data: services } = await supabase
    .from("services")
    .select("id, name, price_cents")
    .eq("salon_id", ctx.salon.id)
    .is("deleted_at" as never, null)
    .order("name", { ascending: true });

  return {
    promos: promoList,
    svcRules,
    services: (services ?? []) as { id: string; name: string; price_cents: number | null }[],
  };
}
