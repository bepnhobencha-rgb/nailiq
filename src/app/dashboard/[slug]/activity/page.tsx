import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { loadActivityFeed } from "@/shared/dashboard/loadActivityFeedAction";
import { ActivityFeed } from "@/components/dashboard/ActivityFeed";
import { PlatformAnnouncementCenter } from "@/components/dashboard/PlatformAnnouncementCenter";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { isArchivedBookingFeatureAvailable } from "@/shared/dashboard/archivedBookingFeatureAccess";
import {
  loadDashboardAnnouncements,
  loadPlatformNotificationPreference,
} from "@/shared/dashboard/platformAnnouncements";
import { resolveUserLanguage } from "@/shared/i18n/user/resolveUserLanguage";

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

  const [res, productAnnouncements, userLanguage, productNotificationPreference] = await Promise.all([
    loadActivityFeed(slug),
    loadDashboardAnnouncements(ctx.role),
    resolveUserLanguage(),
    loadPlatformNotificationPreference(),
  ]);
  const items = res.ok ? res.items : [];
  // The central member-profile RPC already returned an allowlisted flag map.
  const archivedBookingFeatureEnabled =
    await isArchivedBookingFeatureAvailable(ctx.salon);
  // Serialize one server-owned clock snapshot. ActivityFeed uses this exact
  // instant for SSR and its first client render, preventing React #418 when a
  // relative-time label crosses a minute boundary during hydration.
  const initialNowIso = new Date().toISOString();

  return (
    <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
      <PlatformAnnouncementCenter
        slug={slug}
        language={userLanguage}
        announcements={productAnnouncements}
        autoManageRoutine={productNotificationPreference.autoManageRoutine}
        nowIso={initialNowIso}
      />
      <ActivityFeed
        slug={slug}
        items={items}
        initialNowIso={initialNowIso}
        timeZone={ctx.salon.timezone}
        archivedBookingFeatureEnabled={archivedBookingFeatureEnabled}
      />
    </div>
  );
}
