"use server";

/**
 * Owner-facing CRUD for the optional resource layer (beds/chairs/stations) +
 * the per-salon resource-mode toggle. Mirrors the salonOwnerActions auth pattern
 * (getDashboardWriteClient + owner-only). `salon_resources` and the new salons
 * columns aren't in database.types.ts yet → `as never` casts, the established
 * workaround in this codebase.
 */
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { resolveVertical } from "@/shared/verticals/registry";

export type ResourceRow = {
  id: string;
  name: string;
  kind: string;
  display_order: number;
  status: string;
  same_guest_parallel_capacity: 1 | 2;
};

export type ParallelServiceOption = {
  id: string;
  name: string;
};

export type ParallelServicePolicyRow = {
  id: string;
  service_a_id: string;
  service_b_id: string;
  resource_mode: "shared" | "distinct" | "either";
  active: boolean;
};

type Result<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

async function ownerCtx(slug: string) {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ctx: null, err: "unauthorized" };
  if (ctx.role !== "owner") return { ctx: null, err: "forbidden" };
  return { ctx, err: null };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set(["station", "chair", "bed", "backwash", "room", "other"]);

export async function listResources(slug: string): Promise<Result<{ resources: ResourceRow[] }>> {
  const { ctx, err } = await ownerCtx(slug);
  if (!ctx) return { ok: false, error: err };
  const { data, error } = await ctx.supabase
    .from("salon_resources" as never)
    .select("id, name, kind, display_order, status, same_guest_parallel_capacity")
    .eq("salon_id" as never, ctx.salon.id as never)
    .is("deleted_at" as never, null)
    .order("display_order" as never, { ascending: true });
  if (error) return { ok: false, error: error.message };
  return { ok: true, resources: (data as unknown as ResourceRow[]) ?? [] };
}

export async function listResourceSettings(
  slug: string,
): Promise<
  Result<{
    resources: ResourceRow[];
    services: ParallelServiceOption[];
    policies: ParallelServicePolicyRow[];
  }>
> {
  const { ctx, err } = await ownerCtx(slug);
  if (!ctx) return { ok: false, error: err };

  const [resourcesResult, servicesResult, policiesResult] = await Promise.all([
    ctx.supabase
      .from("salon_resources" as never)
      .select("id, name, kind, display_order, status, same_guest_parallel_capacity")
      .eq("salon_id" as never, ctx.salon.id as never)
      .is("deleted_at" as never, null)
      .order("display_order" as never, { ascending: true }),
    ctx.supabase
      .from("services")
      .select("id, name")
      .eq("salon_id", ctx.salon.id)
      .eq("is_addon", false)
      .is("deleted_at" as never, null)
      .order("name", { ascending: true }),
    ctx.supabase
      .from("service_parallel_policies" as never)
      .select("id, service_a_id, service_b_id, resource_mode, active")
      .eq("salon_id" as never, ctx.salon.id as never)
      .order("created_at" as never, { ascending: true }),
  ]);

  if (resourcesResult.error) return { ok: false, error: resourcesResult.error.message };
  if (servicesResult.error) return { ok: false, error: servicesResult.error.message };
  if (policiesResult.error) return { ok: false, error: policiesResult.error.message };
  return {
    ok: true,
    resources: (resourcesResult.data as unknown as ResourceRow[] | null) ?? [],
    services: (servicesResult.data as ParallelServiceOption[] | null) ?? [],
    policies:
      (policiesResult.data as unknown as ParallelServicePolicyRow[] | null) ?? [],
  };
}

export async function createResource(
  slug: string,
  input: { name: string; kind?: string },
): Promise<Result<{ id: string }>> {
  const { ctx, err } = await ownerCtx(slug);
  if (!ctx) return { ok: false, error: err };
  const name = String(input.name ?? "").trim().slice(0, 60);
  if (!name) return { ok: false, error: "invalid_name" };
  const kind = input.kind && KINDS.has(input.kind) ? input.kind : "station";

  // Append at the end (max display_order + 1).
  const { data: maxRow } = await ctx.supabase
    .from("salon_resources" as never)
    .select("display_order")
    .eq("salon_id" as never, ctx.salon.id as never)
    .is("deleted_at" as never, null)
    .order("display_order" as never, { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextOrder = ((maxRow as { display_order?: number } | null)?.display_order ?? -1) + 1;

  const { data, error } = await ctx.supabase
    .from("salon_resources" as never)
    .insert({ salon_id: ctx.salon.id, name, kind, display_order: nextOrder } as never)
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: (data as unknown as { id: string }).id };
}

export async function updateResource(
  slug: string,
  input: {
    id: string;
    name?: string;
    kind?: string;
    status?: "active" | "inactive";
    sameGuestParallelCapacity?: 1 | 2;
  },
): Promise<Result> {
  const { ctx, err } = await ownerCtx(slug);
  if (!ctx) return { ok: false, error: err };
  if (!UUID_RE.test(String(input.id))) return { ok: false, error: "invalid_id" };

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = String(input.name).trim().slice(0, 60);
    if (!name) return { ok: false, error: "invalid_name" };
    patch.name = name;
  }
  if (input.kind !== undefined) patch.kind = KINDS.has(input.kind) ? input.kind : "station";
  if (input.status !== undefined) patch.status = input.status === "inactive" ? "inactive" : "active";
  if (input.sameGuestParallelCapacity !== undefined) {
    if (input.sameGuestParallelCapacity !== 1 && input.sameGuestParallelCapacity !== 2) {
      return { ok: false, error: "invalid_parallel_capacity" };
    }
    patch.same_guest_parallel_capacity = input.sameGuestParallelCapacity;
  }
  if (Object.keys(patch).length === 0) return { ok: true };

  const { error } = await ctx.supabase
    .from("salon_resources" as never)
    .update(patch as never)
    .eq("id" as never, input.id as never)
    .eq("salon_id" as never, ctx.salon.id as never);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function saveParallelServicePolicy(
  slug: string,
  input: {
    serviceAId: string;
    serviceBId: string;
    resourceMode: "shared" | "distinct" | "either";
  },
): Promise<Result<{ policy: ParallelServicePolicyRow }>> {
  const { ctx, err } = await ownerCtx(slug);
  if (!ctx) return { ok: false, error: err };
  if (
    !UUID_RE.test(input.serviceAId) ||
    !UUID_RE.test(input.serviceBId) ||
    input.serviceAId === input.serviceBId ||
    !["shared", "distinct", "either"].includes(input.resourceMode)
  ) {
    return { ok: false, error: "invalid_parallel_policy" };
  }

  const [serviceAId, serviceBId] = [input.serviceAId, input.serviceBId]
    .map((id) => id.toLowerCase())
    .sort();
  const { data, error } = await ctx.supabase
    .from("service_parallel_policies" as never)
    .upsert(
      {
        salon_id: ctx.salon.id,
        service_a_id: serviceAId,
        service_b_id: serviceBId,
        resource_mode: input.resourceMode,
        active: true,
      } as never,
      { onConflict: "salon_id,service_a_id,service_b_id" },
    )
    .select("id, service_a_id, service_b_id, resource_mode, active")
    .single();
  if (error) return { ok: false, error: error.message };
  return {
    ok: true,
    policy: data as unknown as ParallelServicePolicyRow,
  };
}

export async function deleteParallelServicePolicy(
  slug: string,
  id: string,
): Promise<Result> {
  const { ctx, err } = await ownerCtx(slug);
  if (!ctx) return { ok: false, error: err };
  if (!UUID_RE.test(id)) return { ok: false, error: "invalid_id" };
  const { error } = await ctx.supabase
    .from("service_parallel_policies" as never)
    .delete()
    .eq("id" as never, id as never)
    .eq("salon_id" as never, ctx.salon.id as never);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Soft-delete a resource (kept for booking history integrity). */
export async function deleteResource(slug: string, id: string): Promise<Result> {
  const { ctx, err } = await ownerCtx(slug);
  if (!ctx) return { ok: false, error: err };
  if (!UUID_RE.test(String(id))) return { ok: false, error: "invalid_id" };
  const { error } = await ctx.supabase
    .from("salon_resources" as never)
    .update({ deleted_at: new Date().toISOString(), status: "inactive" } as never)
    .eq("id" as never, id as never)
    .eq("salon_id" as never, ctx.salon.id as never);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function reorderResources(slug: string, orderedIds: string[]): Promise<Result> {
  const { ctx, err } = await ownerCtx(slug);
  if (!ctx) return { ok: false, error: err };
  for (let i = 0; i < orderedIds.length; i++) {
    if (!UUID_RE.test(String(orderedIds[i]))) continue;
    const { error } = await ctx.supabase
      .from("salon_resources" as never)
      .update({ display_order: i } as never)
      .eq("id" as never, orderedIds[i] as never)
      .eq("salon_id" as never, ctx.salon.id as never);
    if (error) return { ok: false, error: error.message };
  }
  return { ok: true };
}

export async function setResourcesMode(
  slug: string,
  input: { enabled: boolean; axis: "staff" | "resource" },
): Promise<Result> {
  const { ctx, err } = await ownerCtx(slug);
  if (!ctx) return { ok: false, error: err };
  const axis = input.axis === "resource" ? "resource" : "staff";
  const { error } = await ctx.supabase
    .from("salons")
    .update({ resources_enabled: !!input.enabled, primary_grid_axis: axis } as never)
    .eq("id", ctx.salon.id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * One-click setup: seed the vertical's default resources (if none yet), turn the
 * layer on, and set the vertical's natural grid axis. Idempotent-ish: only seeds
 * when the salon has zero live resources.
 */
export async function applyResourcePreset(slug: string): Promise<Result<{ seeded: number }>> {
  const { ctx, err } = await ownerCtx(slug);
  if (!ctx) return { ok: false, error: err };

  const { data: salonRow } = await ctx.supabase
    .from("salons")
    .select("vertical")
    .eq("id", ctx.salon.id)
    .maybeSingle();
  const preset = resolveVertical((salonRow as { vertical?: string } | null)?.vertical).resourceDefaults;
  if (!preset) return { ok: false, error: "no_preset_for_vertical" };

  const { data: existing } = await ctx.supabase
    .from("salon_resources" as never)
    .select("id")
    .eq("salon_id" as never, ctx.salon.id as never)
    .is("deleted_at" as never, null)
    .limit(1);
  let seeded = 0;
  if (!((existing as unknown[]) ?? []).length) {
    const rows = preset.seedNames.map((name, i) => ({
      salon_id: ctx.salon.id,
      name,
      kind: preset.kind,
      display_order: i,
    }));
    const { error } = await ctx.supabase.from("salon_resources" as never).insert(rows as never);
    if (error) return { ok: false, error: error.message };
    seeded = rows.length;
  }

  const { error: upErr } = await ctx.supabase
    .from("salons")
    .update({ resources_enabled: true, primary_grid_axis: preset.gridAxis } as never)
    .eq("id", ctx.salon.id);
  if (upErr) return { ok: false, error: upErr.message };
  return { ok: true, seeded };
}
