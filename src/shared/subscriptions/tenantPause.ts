import type { SupabaseClient } from "@supabase/supabase-js";

export const TENANT_PAUSE_FIELDS = [
  "sms_outbound_enabled",
  "email_outbound_enabled",
  "reminders_enabled",
  "voice_ai_enabled",
  "voice_ai_upsell_enabled",
  "winback_enabled",
  "phone_otp_enabled",
  "email_links_enabled",
] as const;

export type TenantPauseReason = "manual" | "non_payment";
export type TenantPauseSnapshot = Record<(typeof TENANT_PAUSE_FIELDS)[number], boolean>;

type TenantPauseRow = TenantPauseSnapshot & {
  id: string;
  archived_at: string | null;
  tenant_pause_reason: TenantPauseReason | null;
  tenant_pause_snapshot: unknown;
};

function snapshotFromRow(row: TenantPauseRow): TenantPauseSnapshot {
  return Object.fromEntries(
    TENANT_PAUSE_FIELDS.map((key) => [key, row[key] === true]),
  ) as TenantPauseSnapshot;
}

function normalizeSnapshot(value: unknown): Partial<TenantPauseSnapshot> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  return Object.fromEntries(
    TENANT_PAUSE_FIELDS.flatMap((key) =>
      typeof raw[key] === "boolean" ? [[key, raw[key]]] : [],
    ),
  ) as Partial<TenantPauseSnapshot>;
}

export async function pauseTenant(
  db: SupabaseClient,
  input: {
    salonId: string;
    reason: TenantPauseReason;
    note?: string | null;
    actorUserId?: string | null;
  },
): Promise<{ ok: true; alreadyPaused: boolean; before: TenantPauseRow } | { ok: false; error: unknown }> {
  const selectFields = [
    "id",
    "archived_at",
    "tenant_pause_reason",
    "tenant_pause_snapshot",
    ...TENANT_PAUSE_FIELDS,
  ].join(",");
  const { data, error } = await db
    .from("salons")
    .select(selectFields)
    .eq("id", input.salonId)
    .maybeSingle();
  if (error || !data) return { ok: false, error: error ?? "not_found" };

  const before = data as unknown as TenantPauseRow;
  const alreadyPaused = before.archived_at != null;
  const patch: Record<string, unknown> = {
    archived_at: before.archived_at ?? new Date().toISOString(),
    tenant_pause_reason: input.reason,
    tenant_pause_note: input.note?.trim() || null,
    tenant_paused_by: input.actorUserId ?? null,
    payment_grace_ends_at: null,
    sms_outbound_enabled: false,
    email_outbound_enabled: false,
    reminders_enabled: false,
    voice_ai_enabled: false,
    voice_ai_upsell_enabled: false,
    winback_enabled: false,
    phone_otp_enabled: false,
    email_links_enabled: false,
  };
  // Never replace the original pre-pause configuration during an idempotent
  // retry. This is what makes resume exact instead of restoring defaults.
  if (!alreadyPaused || !before.tenant_pause_snapshot) {
    patch.tenant_pause_snapshot = snapshotFromRow(before);
  }

  const { error: updateError } = await db
    .from("salons")
    .update(patch as never)
    .eq("id", input.salonId);
  if (updateError) return { ok: false, error: updateError };
  return { ok: true, alreadyPaused, before };
}

export async function resumeTenant(
  db: SupabaseClient,
  salonId: string,
): Promise<{ ok: true; before: TenantPauseRow } | { ok: false; error: unknown }> {
  const selectFields = [
    "id",
    "archived_at",
    "tenant_pause_reason",
    "tenant_pause_snapshot",
    ...TENANT_PAUSE_FIELDS,
  ].join(",");
  const { data, error } = await db
    .from("salons")
    .select(selectFields)
    .eq("id", salonId)
    .maybeSingle();
  if (error || !data) return { ok: false, error: error ?? "not_found" };

  const before = data as unknown as TenantPauseRow;
  const snapshot = normalizeSnapshot(before.tenant_pause_snapshot);
  const { error: updateError } = await db
    .from("salons")
    .update({
      archived_at: null,
      tenant_pause_reason: null,
      tenant_pause_note: null,
      tenant_pause_snapshot: null,
      tenant_paused_by: null,
      payment_grace_ends_at: null,
      ...snapshot,
    } as never)
    .eq("id", salonId);
  if (updateError) return { ok: false, error: updateError };
  return { ok: true, before };
}

export function graceDeadline(days: number, now = new Date()): string {
  const safeDays = Math.min(30, Math.max(1, Math.round(days)));
  return new Date(now.getTime() + safeDays * 86_400_000).toISOString();
}
