import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { loadActivityFeed } from "@/shared/dashboard/loadActivityFeedAction";
import { loadWinbackSuggestions } from "@/shared/winback/winbackActions";
import { ActivityFeed } from "@/components/dashboard/ActivityFeed";
import { WinbackSuggestionsPanel } from "@/components/dashboard/WinbackSuggestionsPanel";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Nhật ký hoạt động · ${slug}` };
}

export default async function ActivityPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");
  if (!isOwnerOrAdmin(ctx.role)) redirect(`/dashboard/${slug}`);

  const [feedRes, suggestionsRes] = await Promise.all([
    loadActivityFeed(slug),
    loadWinbackSuggestions(slug),
  ]);

  const items = feedRes.ok ? feedRes.items : [];
  const pendingSuggestions = suggestionsRes.ok ? suggestionsRes.items : [];

  return (
    <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
      <WinbackSuggestionsPanel slug={slug} initialItems={pendingSuggestions} />
      <ActivityFeed slug={slug} items={items} />
    </div>
  );
}
