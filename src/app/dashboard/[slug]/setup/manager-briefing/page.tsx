import { notFound, redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { ManagerBriefingChat } from "@/components/ai/ManagerBriefingChat";
import type { SalonIntelligenceProfile } from "@/shared/ai/types";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export default async function ManagerBriefingPage({ params }: PageProps) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");
  if (!isOwnerOrAdmin(ctx.role)) redirect(`/dashboard/${slug}/setup`);

  // Check if briefing was already done
  const { data: row } = await ctx.supabase
    .from("salons")
    .select("ai_profile")
    .eq("id", ctx.salon.id)
    .single();

  if (!row) notFound();

  const alreadyConfigured =
    row !== null &&
    typeof row === "object" &&
    "ai_profile" in row &&
    row.ai_profile !== null &&
    (row.ai_profile as SalonIntelligenceProfile | null)?.built_via === "manager_briefing";

  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-lg flex-col px-4 py-6">
      <div className="mb-5">
        <h1 className="text-xl font-bold text-nq-foreground">AI Manager Briefing</h1>
        {alreadyConfigured ? (
          <p className="mt-1 text-sm text-nq-muted">
            AI Manager đã được cấu hình. Trả lời lại 7 câu để cập nhật.
          </p>
        ) : (
          <p className="mt-1 text-sm text-nq-muted">
            Trả lời 7 câu hỏi ngắn để AI Manager hiểu tiệm của bạn.
          </p>
        )}
      </div>

      {/* Chat occupies the rest of the viewport */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <ManagerBriefingChat slug={slug} alreadyConfigured={!!alreadyConfigured} />
      </div>
    </div>
  );
}
