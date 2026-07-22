import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { ImportFromWebsite } from "@/components/import/ImportFromWebsite";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import type { ImportJob } from "@/shared/import/types";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Import from Website · ${slug}`, robots: "noindex" };
}

export default async function ImportPage({ params }: PageProps) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");

  const { salon } = ctx;
  const db = createServiceRoleClient();

  // Load most recent job for this salon
  const { data: latestJob } = await db
    .from("website_import_jobs")
    .select("id, status, progress, result, error_message, source_url, created_at")
    .eq("salon_id", salon.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Import from Website</h1>
        <p className="text-sm text-[#a1a1aa] mt-1">
          Paste your existing salon website URL and we&apos;ll automatically build your NailIQ page.
        </p>
      </div>

      <ImportFromWebsite slug={slug} initialJob={latestJob as ImportJob | null} />

      <div className="text-xs text-[#52525b] space-y-1">
        <p>• We&apos;ll extract your services, pricing, photos, and salon details.</p>
        <p>• Images are downloaded to our servers — no hotlinking.</p>
        <p>• You can edit everything after import.</p>
        <p>• One import allowed per 24 hours.</p>
      </div>
    </div>
  );
}
