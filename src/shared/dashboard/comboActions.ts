"use server";

import { revalidatePath } from "next/cache";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";

export type ComboRow = {
  id: string;
  name: string;
  description: string | null;
  service_ids: string[];
  price_cents: number;
  discount_cents: number;
  duration_minutes: number;
  is_active: boolean;
  position: number;
};

export type SaveComboInput = {
  id?: string | null;
  name: string;
  description?: string | null;
  serviceIds: string[];
  priceCents: number;
  discountCents: number;
  durationMinutes: number;
  isActive: boolean;
};

type ComboActionResult =
  | { ok: true; combo: ComboRow }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "forbidden"
        | "invalid_input"
        | "not_found"
        | "server_error";
    };

type DeleteComboResult =
  | { ok: true }
  | {
      ok: false;
      error: "unauthorized" | "forbidden" | "not_found" | "server_error";
    };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    return null;
  }
  return number;
}

function normalizeInput(input: SaveComboInput) {
  const id =
    typeof input.id === "string" && UUID_PATTERN.test(input.id)
      ? input.id
      : input.id == null
        ? null
        : undefined;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const description =
    typeof input.description === "string" && input.description.trim()
      ? input.description.trim()
      : null;
  const serviceIds = Array.from(
    new Set(
      Array.isArray(input.serviceIds)
        ? input.serviceIds.filter(
            (serviceId): serviceId is string =>
              typeof serviceId === "string" && UUID_PATTERN.test(serviceId),
          )
        : [],
    ),
  );
  const priceCents = asBoundedInteger(input.priceCents, 0, 10_000_000);
  const discountCents = asBoundedInteger(input.discountCents, 0, 10_000_000);
  const durationMinutes = asBoundedInteger(input.durationMinutes, 1, 1_440);
  const descriptionTooLong =
    description !== null && description.length > 1_000;

  if (
    id === undefined ||
    name.length === 0 ||
    name.length > 160 ||
    descriptionTooLong ||
    serviceIds.length < 2 ||
    serviceIds.length !== input.serviceIds.length ||
    priceCents === null ||
    discountCents === null ||
    durationMinutes === null ||
    typeof input.isActive !== "boolean"
  ) {
    return null;
  }

  return {
    id,
    name,
    description,
    serviceIds,
    priceCents,
    discountCents,
    durationMinutes,
    isActive: input.isActive,
  };
}

export async function saveServiceCombo(
  slug: string,
  input: SaveComboInput,
): Promise<ComboActionResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const normalized = normalizeInput(input);
  if (!normalized) return { ok: false, error: "invalid_input" };

  const { data: matchingServices, error: servicesError } = await ctx.supabase
    .from("services")
    .select("id")
    .eq("salon_id", ctx.salon.id)
    .is("deleted_at" as never, null)
    .in("id", normalized.serviceIds);

  if (servicesError) {
    console.error("[saveServiceCombo] validate services", servicesError);
    return { ok: false, error: "server_error" };
  }
  if ((matchingServices ?? []).length !== normalized.serviceIds.length) {
    return { ok: false, error: "invalid_input" };
  }

  const payload = {
    salon_id: ctx.salon.id,
    name: normalized.name,
    description: normalized.description,
    service_ids: normalized.serviceIds,
    price_cents: normalized.priceCents,
    discount_cents: normalized.discountCents,
    duration_minutes: normalized.durationMinutes,
    is_active: normalized.isActive,
    updated_at: new Date().toISOString(),
  };

  let combo: ComboRow | null = null;
  let writeError: { message?: string } | null = null;

  if (normalized.id) {
    const { data, error } = await ctx.supabase
      .from("service_combos" as never)
      .update(payload as never)
      .eq("id", normalized.id)
      .eq("salon_id", ctx.salon.id)
      .select(
        "id, name, description, service_ids, price_cents, discount_cents, duration_minutes, is_active, position",
      )
      .maybeSingle();
    combo = data as ComboRow | null;
    writeError = error;
  } else {
    const { data: lastCombo, error: positionError } = await ctx.supabase
      .from("service_combos" as never)
      .select("position")
      .eq("salon_id", ctx.salon.id)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (positionError) {
      console.error("[saveServiceCombo] load position", positionError);
      return { ok: false, error: "server_error" };
    }

    const lastPositionValue = (
      lastCombo as { position?: unknown } | null
    )?.position;
    const lastPosition =
      typeof lastPositionValue === "number" ? lastPositionValue : -1;
    const { data, error } = await ctx.supabase
      .from("service_combos" as never)
      .insert({ ...payload, position: lastPosition + 1 } as never)
      .select(
        "id, name, description, service_ids, price_cents, discount_cents, duration_minutes, is_active, position",
      )
      .single();
    combo = data as ComboRow | null;
    writeError = error;
  }

  if (writeError) {
    console.error("[saveServiceCombo] write", writeError);
    return { ok: false, error: "server_error" };
  }
  if (!combo) return { ok: false, error: "not_found" };

  revalidatePath(`/dashboard/${encodeURIComponent(slug)}/combos`);
  revalidatePath(`/${encodeURIComponent(slug)}`);
  return { ok: true, combo };
}

export async function deleteServiceCombo(
  slug: string,
  comboId: string,
): Promise<DeleteComboResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };
  if (!UUID_PATTERN.test(comboId)) return { ok: false, error: "not_found" };

  const { data, error } = await ctx.supabase
    .from("service_combos" as never)
    .delete()
    .eq("id", comboId)
    .eq("salon_id", ctx.salon.id)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[deleteServiceCombo]", error);
    return { ok: false, error: "server_error" };
  }
  if (!data) return { ok: false, error: "not_found" };

  revalidatePath(`/dashboard/${encodeURIComponent(slug)}/combos`);
  revalidatePath(`/${encodeURIComponent(slug)}`);
  return { ok: true };
}
