import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { loadActivityFeed } from "@/shared/dashboard/loadActivityFeedAction";
import { ActivityFeed } from "@/components/dashboard/ActivityFeed";
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

  const res = await loadActivityFeed(slug);
  const items = res.ok ? res.items : [];
  // Serialize one server-owned clock snapshot. ActivityFeed uses this exact
  // instant for SSR and its first client render, preventing React #418 when a
  // relative-time label crosses a minute boundary during hydration.
  const initialNowIso = new Date().toISOString();

  return (
    <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
      <ActivityFeed
        slug={slug}
        items={items}
        initialNowIso={initialNowIso}
        timeZone={ctx.salon.timezone}
      />
    </div>
  );
}
