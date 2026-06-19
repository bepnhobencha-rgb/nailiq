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

  const { data: row } = await ctx.supabase
    .from("salons")
    .select("ai_profile")
    .eq("id", ctx.salon.id)
    .single();

  if (!row) notFound();

  const existingSip = (row.ai_profile as SalonIntelligenceProfile | null) ?? null;
  const alreadyHandCrafted = existingSip?.built_via === "manager_briefing";
  const autoLearned = existingSip !== null && !alreadyHandCrafted;

  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-lg flex-col px-4 py-6">
      <div className="mb-5">
        <h1 className="text-xl font-bold text-nq-foreground">
          {autoLearned ? "Minh đã tự tìm hiểu tiệm bạn 🎓" : "Cấu hình AI Manager"}
        </h1>
        <p className="mt-1 text-sm text-nq-muted">
          {autoLearned
            ? "Minh đã đọc dữ liệu tiệm và tự cấu hình. Xác nhận 2 điều Minh chưa đoán được — xong trong 1 phút."
            : alreadyHandCrafted
              ? "Cập nhật lại cấu hình AI Manager bất kỳ lúc nào."
              : "Trả lời vài câu ngắn để Minh hiểu tiệm của bạn."}
        </p>
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <ManagerBriefingChat
          slug={slug}
          salonName={ctx.salon.name}
          existingSip={existingSip}
          alreadyConfigured={alreadyHandCrafted}
        />
      </div>
    </div>
  );
}
