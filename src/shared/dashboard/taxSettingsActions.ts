"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { resolveSalonForDashboard } from "@/shared/dashboard/salonOwnerActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import type { TaxLine } from "@/shared/tax/taxTypes";

function parseTaxLines(raw: unknown): TaxLine[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .map((item) => ({
      name: typeof item.name === "string" ? item.name : "",
      rate: typeof item.rate === "number" ? item.rate : 0,
      enabled: item.enabled !== false,
    }))
    .filter((l) => l.name.length > 0);
}

export async function loadTaxSettings(slug: string): Promise<{
  ok: boolean;
  taxLines: TaxLine[];
  preset: TaxLine[] | null;
  locationLabel: string | null;
}> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return { ok: false, taxLines: [], preset: null, locationLabel: null };
  // Tax configuration is part of the management-only settings surface. This
  // exported Server Action must enforce the same role boundary itself because
  // a hidden/redirected page does not prevent a lower-role client from
  // invoking the action directly.
  if (!isOwnerOrAdmin(resolved.role)) {
    return { ok: false, taxLines: [], preset: null, locationLabel: null };
  }

  const supabase = createServiceRoleClient();
  const salonId = String(resolved.salon.id);

  const { data, error } = await supabase
    .from("salons" as never)
    .select("tax_lines, timezone" as never)
    .eq("id", salonId)
    .single();

  if (error || !data) return { ok: false, taxLines: [], preset: null, locationLabel: null };

  const row = data as { tax_lines?: unknown; timezone?: unknown };
  const taxLines = parseTaxLines(row.tax_lines);
  const timezone = typeof row.timezone === "string" ? row.timezone : null;

  // Load preset and label for this salon's timezone (for "Reset to default" button)
  let preset: TaxLine[] | null = null;
  let locationLabel: string | null = null;

  if (timezone) {
    const { data: presetRow } = await supabase
      .from("tax_presets" as never)
      .select("tax_lines, label" as never)
      .eq("timezone" as never, timezone)
      .maybeSingle();

    if (presetRow) {
      const p = presetRow as { tax_lines?: unknown; label?: unknown };
      preset = parseTaxLines(p.tax_lines);
      locationLabel = typeof p.label === "string" ? p.label : null;
    }
  }

  return { ok: true, taxLines, preset, locationLabel };
}

export async function saveTaxSettings(
  slug: string,
  taxLines: TaxLine[],
): Promise<{ ok: boolean; error?: string }> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(resolved.role)) return { ok: false, error: "unauthorized" };

  for (const line of taxLines) {
    if (!line.name.trim()) return { ok: false, error: "empty_name" };
    if (line.rate < 0 || line.rate > 1) return { ok: false, error: "invalid_rate" };
  }

  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("salons" as never)
    .update({ tax_lines: taxLines } as never)
    .eq("id", String(resolved.salon.id));

  if (error) return { ok: false, error: "server_error" };
  return { ok: true };
}
