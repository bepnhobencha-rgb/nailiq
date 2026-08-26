import { NextResponse } from "next/server";
import { z } from "zod";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";

const bodySchema = z.object({
  slug: z.string().min(1),
  url: z.string().url(),
});

// Domains we refuse to import (circular self-import, localhost abuse)
const BLOCKED_DOMAINS = ["nailiq.ca", "nailiq.vercel.app", "localhost", "127.0.0.1"];

function isBlockedUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return BLOCKED_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return true;
  }
}

export async function POST(req: Request) {
  if (!isSameOriginMutation(req)) {
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  }
  // Emergency fail-closed kill switch. Keep the importer unavailable until
  // its outbound-fetch SSRF defenses have passed security verification.
  if (process.env.WEBSITE_IMPORT_ENABLED !== "true") {
    return NextResponse.json({ error: "website_import_disabled" }, { status: 503 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", issues: parsed.error.issues }, { status: 400 });
  }

  const { slug, url: sourceUrl } = parsed.data;

  if (isBlockedUrl(sourceUrl)) {
    return NextResponse.json({ error: "blocked_url" }, { status: 400 });
  }

  // Auth: importing can overwrite public salon content, so membership alone
  // is insufficient even though the importer is currently behind a kill switch.
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isOwnerOrAdmin(ctx.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { salon } = ctx;
  const db = createServiceRoleClient();

  // Rate-limit: 1 import per salon per 24 h
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await db
    .from("website_import_jobs")
    .select("id", { count: "exact", head: true })
    .eq("salon_id", salon.id)
    .gte("created_at", since);

  if ((count ?? 0) >= 1) {
    return NextResponse.json(
      { error: "rate_limited", message: "One import allowed per salon per 24 hours" },
      { status: 429 },
    );
  }

  // Create job row
  const { data: job, error: insertErr } = await db
    .from("website_import_jobs")
    .insert({
      salon_id: salon.id,
      source_url: sourceUrl,
      status: "pending",
      progress: 0,
    } as never)
    .select("id")
    .single();

  if (insertErr || !job) {
    console.error("[import-website] insert job error", insertErr);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  const jobId = (job as { id: string }).id;

  // Fire-and-forget Edge Function
  const edgeFnUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/scrape-website`;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  fetch(edgeFnUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
    },
    body: JSON.stringify({
      jobId,
      sourceUrl,
      salonId: salon.id,
      salonSlug: salon.slug,
      salonEmail: salon.email ?? "",
    }),
  }).catch((err) => console.error("[import-website] edge fn invoke error", err));

  return NextResponse.json({ jobId });
}
