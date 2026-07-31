/**
 * Bulk-migrate all active salons to use Resend-backed email sends.
 *
 * Default mode is DRY-RUN (only prints what would change), to avoid
 * surprise writes. Add `--apply` to perform the update in one query.
 *
 * Usage:
 *   # Preview:
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/enable-all-salons-email-outbound.ts
 *
 *   # Apply:
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/enable-all-salons-email-outbound.ts --apply
 */
import { createClient } from "@supabase/supabase-js";

type SalonRow = {
  id: string;
  slug: string;
  name: string | null;
};

const args = new Set(process.argv.slice(2));
const shouldApply = args.has("--apply");
const includeArchived = args.has("--include-archived");
const sampleLimit = Number.parseInt(
  process.env.RESEND_MIGRATION_SAMPLE_LIMIT ?? "20",
  10,
);
const MAX_SAMPLE = Number.isFinite(sampleLimit) && sampleLimit > 0 ? sampleLimit : 20;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url?.trim() || !key?.trim()) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (service role key required).",
  );
  process.exit(1);
}

const db = createClient(url, key);

function formatLine(salon: SalonRow): string {
  const slug = salon.slug || "(no-slug)";
  const name = salon.name?.trim().length ? salon.name!.trim() : "(no-name)";
  return `${slug} (${name})`;
}

async function run() {
  const baseTargetQuery = db
    .from("salons")
    .select("id, slug, name")
    .eq("email_outbound_enabled", false)
    .order("created_at", { ascending: true });

  const targetResult = (await (includeArchived
    ? baseTargetQuery
    : baseTargetQuery.is("archived_at", null))) as {
    data: SalonRow[] | null;
    error: unknown;
  };
  const { data: targetData, error: targetError } = targetResult;

  if (targetError) {
    console.error("Failed to query target salons:", targetError);
    process.exit(1);
  }

  const target = targetData ?? [];
  const sample = target.slice(0, MAX_SAMPLE);

  if (!target.length) {
    console.log("✅ No active salons found with email_outbound_enabled = false.");
  } else {
    console.log(
      `Found ${target.length} active salons with email_outbound_enabled = false.`,
    );
    console.log(`Sample (${Math.min(MAX_SAMPLE, target.length)}):`);
    for (const salon of sample) {
      console.log(`- ${formatLine(salon)}`);
    }
  }

  if (!shouldApply) {
    if (target.length === 0) return;

    console.log(
      "\nDry-run only. Add `--apply` to enable email_outbound_enabled for these salons.",
    );
    return;
  }

  console.log("\nApplying migration...");
  const updatedResult = (await (includeArchived
    ? db
        .from("salons")
        .update({ email_outbound_enabled: true })
        .eq("email_outbound_enabled", false)
        .select("id")
    : db
        .from("salons")
        .update({ email_outbound_enabled: true })
        .eq("email_outbound_enabled", false)
        .is("archived_at", null)
        .select("id"))) as {
    data: Array<{ id: string }> | null;
    error: unknown;
  };

  if (updatedResult.error) {
    console.error("Failed to update salons:", updatedResult.error);
    process.exit(1);
  }

  const updatedCount = updatedResult.data?.length ?? 0;
  console.log(`✅ Updated ${updatedCount} salons.`);

  const remainingResult = (await (includeArchived
    ? db
        .from("salons")
        .select("*", { count: "exact", head: true })
        .eq("email_outbound_enabled", false)
    : db
        .from("salons")
        .select("*", { count: "exact", head: true })
        .eq("email_outbound_enabled", false)
        .is("archived_at", null))) as {
    count: number | null;
    error: unknown;
  };

  const { count: remaining, error: remainingError } = remainingResult;

  if (remainingError) {
    console.error("Could not verify remaining disabled salons:", remainingError);
    process.exit(1);
  }

  console.log(
    remaining === 0 || remaining === null
      ? "✅ No remaining active salons still with email_outbound_enabled = false."
      : `⚠️ ${remaining} active salon(s) still have email_outbound_enabled = false.`,
  );
}

void run();
