/**
 * One-shot script: backfill `services.description` and seed `is_popular`
 * for a target salon, using the Anthropic API to generate a one-line
 * marketing line per service.
 *
 * Defaults to **dry-run** (no DB writes, no description column changes,
 * popular flags still flipped to demonstrate intent only). Pass
 * `--commit` to actually write to the DB. Always prints a plan first.
 *
 * Requires (in process.env):
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY  (service role — bypasses RLS)
 *   - ANTHROPIC_API_KEY
 *
 * Usage:
 *   npx tsx scripts/generate-service-descriptions.ts                  # dry-run
 *   npx tsx scripts/generate-service-descriptions.ts --commit         # writes
 *   npx tsx scripts/generate-service-descriptions.ts --salon=<uuid>   # custom salon
 *
 * The default salon is the one the user requested for liam-nails:
 * `c610124b-390f-40cd-981a-eeae94abfe05`.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient } from "@supabase/supabase-js";

/** Load env vars from `.env.local` (Next.js convention) before reading
 *  `process.env`. `tsx` doesn't auto-load env files the way `next dev`
 *  does, so without this step `requireEnv` below would always fail
 *  even when the keys are present on disk. */
function loadDotEnv(filename: string) {
  const p = resolve(process.cwd(), filename);
  if (!existsSync(p)) return;
  const raw = readFileSync(p, "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    // Overwrite when the existing value is empty too — Claude Code
    // sets `ANTHROPIC_API_KEY=""` in its child processes (the SDK
    // auths via OAuth), and that empty placeholder would otherwise
    // shadow the real key in `.env.local`.
    const existing = process.env[key];
    if (existing === undefined || existing.trim() === "") {
      process.env[key] = val;
    }
  }
}

loadDotEnv(".env.local");
loadDotEnv(".env.test.local");

type Cli = { salonId: string; commit: boolean };

const DEFAULT_SALON_ID = "c610124b-390f-40cd-981a-eeae94abfe05";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

/** Names to set `is_popular = true` for (case-insensitive exact match). */
const POPULAR_NAMES = new Set(
  [
    "Gel Manicure",
    "Classic Manicure",
    "Pedicure Classic",
    "Acrylic Full Set",
  ].map((n) => n.toLowerCase()),
);

const DESCRIPTION_MAX_LEN = 100;

function parseArgs(argv: string[]): Cli {
  let salonId = DEFAULT_SALON_ID;
  let commit = false;
  for (const arg of argv.slice(2)) {
    if (arg === "--commit") commit = true;
    else if (arg.startsWith("--salon=")) salonId = arg.slice("--salon=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: tsx scripts/generate-service-descriptions.ts [--salon=<uuid>] [--commit]",
      );
      process.exit(0);
    } else {
      console.warn(`Ignoring unknown flag: ${arg}`);
    }
  }
  return { salonId, commit };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`Missing required env var: ${name}`);
    // Help diagnose env-file issues without leaking secrets — list
    // every key whose name looks remotely Anthropic-related so a
    // typo ("ANTHROPIC_KEY", "CLAUDE_API_KEY") becomes obvious.
    const related = Object.keys(process.env)
      .filter((k) => /anthropic|claude|api[_-]?key/i.test(k))
      .sort();
    if (related.length > 0) {
      console.error(
        `Found these vaguely-related keys (value not shown): ${related.join(", ")}`,
      );
    } else {
      console.error(
        `No anthropic/claude/api-key-named env vars are visible at all.`,
      );
    }
    process.exit(2);
  }
  return v;
}

type AnthropicMessageResponse = {
  content?: Array<{ type: string; text?: string }>;
  error?: { type?: string; message?: string };
};

async function generateDescription(
  apiKey: string,
  serviceName: string,
): Promise<string | null> {
  const prompt = `Write a 1-line description (max 10 words) for a nail salon service called '${serviceName}'. Tone: premium, warm, Canadian market. No emoji. Example: 'Gel Manicure' → 'Long-lasting shine, perfectly shaped nails.' Output ONLY the description, nothing else.`;

  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: 80,
    messages: [{ role: "user", content: prompt }],
  };

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`  ✗ Anthropic ${res.status}: ${text.slice(0, 200)}`);
    return null;
  }

  const json = (await res.json()) as AnthropicMessageResponse;
  if (json.error) {
    console.error(`  ✗ Anthropic error: ${json.error.message ?? "unknown"}`);
    return null;
  }
  const raw = json.content?.[0]?.text?.trim() ?? "";
  if (!raw) {
    console.error("  ✗ Empty response");
    return null;
  }

  // Strip any wrapping quotes Claude sometimes adds despite the prompt.
  const cleaned = raw
    .replace(/^["'`]+/, "")
    .replace(/["'`]+$/, "")
    .trim();

  if (cleaned.length > DESCRIPTION_MAX_LEN) {
    console.warn(
      `  ⚠ Generated description exceeds ${DESCRIPTION_MAX_LEN} chars; truncating with ellipsis.`,
    );
    return cleaned.slice(0, DESCRIPTION_MAX_LEN - 1).trimEnd() + "…";
  }
  return cleaned;
}

async function main() {
  const { salonId, commit } = parseArgs(process.argv);
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const anthropicKey = requireEnv("ANTHROPIC_API_KEY");

  const supabase = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(
    `[generate-service-descriptions] salon=${salonId} mode=${commit ? "COMMIT" : "DRY-RUN"}`,
  );

  const { data: rows, error } = (await supabase
    .from("services")
    .select("id, name, description, is_popular")
    .eq("salon_id", salonId)
    .is("deleted_at" as never, null)
    .order("name", { ascending: true })) as {
    data:
      | Array<{
          id: string;
          name: string;
          description: string | null;
          is_popular: boolean | null;
        }>
      | null;
    error: { message: string } | null;
  };

  if (error) {
    console.error("Could not load services:", error.message);
    process.exit(1);
  }
  if (!rows || rows.length === 0) {
    console.log("No services found for this salon. Nothing to do.");
    return;
  }

  const toGenerate = rows.filter(
    (r) => r.description === null || r.description.trim().length === 0,
  );

  console.log(
    `Found ${rows.length} service(s); ${toGenerate.length} need a description.`,
  );

  let updatedDescriptions = 0;
  for (const row of toGenerate) {
    console.log(`• ${row.name} …`);
    const desc = await generateDescription(anthropicKey, row.name);
    if (!desc) continue;
    console.log(`    → "${desc}"`);

    if (!commit) {
      updatedDescriptions += 1;
      continue;
    }

    const { error: updErr } = await supabase
      .from("services")
      .update({ description: desc } as never)
      .eq("id", row.id);
    if (updErr) {
      console.error(`    ✗ DB write failed: ${updErr.message}`);
    } else {
      updatedDescriptions += 1;
    }
  }

  // Flip is_popular for the canonical set, regardless of whether the
  // description already existed. Owner can toggle off later if they
  // want to feature different services.
  const popularRows = rows.filter((r) =>
    POPULAR_NAMES.has(r.name.toLowerCase()),
  );
  console.log(
    `\nPopular flag — ${popularRows.length} match(es) of the curated list.`,
  );
  let popularFlipped = 0;
  for (const row of popularRows) {
    if (row.is_popular === true) {
      console.log(`• ${row.name} → already popular, skipping`);
      continue;
    }
    console.log(`• ${row.name} → set is_popular=true`);
    if (!commit) {
      popularFlipped += 1;
      continue;
    }
    const { error: popErr } = await supabase
      .from("services")
      .update({ is_popular: true } as never)
      .eq("id", row.id);
    if (popErr) {
      console.error(`    ✗ DB write failed: ${popErr.message}`);
    } else {
      popularFlipped += 1;
    }
  }

  console.log(
    `\nSummary — descriptions ${commit ? "written" : "would write"}: ${updatedDescriptions}, ` +
      `popular ${commit ? "flipped" : "would flip"}: ${popularFlipped}.` +
      (commit ? "" : "  (Re-run with --commit to apply.)"),
  );
}

main().catch((err) => {
  console.error("generate-service-descriptions crashed:", err);
  process.exit(1);
});
