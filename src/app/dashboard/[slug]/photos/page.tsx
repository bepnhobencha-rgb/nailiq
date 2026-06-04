import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isFeaturePlatformDisabled } from "@/shared/features/platformFeatureFlags";
import { hasFeature } from "@/lib/feature-gating";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { PhotoGalleryPanel } from "@/components/dashboard/PhotoGalleryPanel";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Photos · ${slug}`,
    robots: "noindex",
  };
}

export type PhotoRow = {
  id: string;
  booking_id: string;
  storage_path: string;
  thumbnail_path: string | null;
  ai_quality_score: number | null;
  ai_detected_style: string | null;
  ai_detected_colors: string[] | null;
  customer_rating: number | null;
  customer_viewed_at: string | null;
  sms_sent_at: string | null;
  created_at: string;
  signedUrl: string | null;
  clientName: string | null;
  serviceName: string | null;
  staffName: string | null;
  appointmentDate: string | null;
};

export default async function PhotosPage({ params }: PageProps) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");
  if (ctx.role !== "owner" && ctx.role !== "senior") {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }
  // Platform kill-switch: hard-block when photos is disabled platform-wide
  // (plan-tier gating still shows the friendly upsell below).
  if (await isFeaturePlatformDisabled("photos")) notFound();

  const { data: planRow } = await ctx.supabase
    .from("salons")
    .select("subscription_plan, plan_override, feature_flags" as never)
    .eq("id", ctx.salon.id)
    .maybeSingle();

  const hasPhotos = hasFeature(
    (planRow ?? { subscription_plan: "free", plan_override: null, feature_flags: null }) as Parameters<typeof hasFeature>[0],
    "photo_confirmation",
  );

  if (!hasPhotos) {
    return (
      <main className="mx-auto w-full max-w-3xl px-5 py-8 md:px-8">
        <header className="flex flex-col gap-2 pb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
            Photos
          </h1>
        </header>
        <div className="flex flex-col gap-3 rounded-xl border border-nq-primary/30 bg-nq-primary/10 px-4 py-4">
          <p className="text-sm font-semibold text-nq-foreground">
            Photo confirmation — gói Pro
          </p>
          <p className="text-sm text-nq-muted">
            Staff chụp ảnh sau mỗi lần làm, AI phân tích chất lượng,
            khách nhận link xem và đánh giá. Tính năng có trong gói Pro.
          </p>
          <div>
            <a
              href={`/dashboard/${encodeURIComponent(slug)}/settings`}
              className="inline-flex items-center justify-center rounded-full bg-nq-primary px-4 py-2 text-sm font-semibold text-nq-bg hover:opacity-90"
            >
              Nâng cấp Pro
            </a>
          </div>
        </div>
      </main>
    );
  }

  // Fetch photos with booking joins — last 90 days, max 200 rows
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const db = createServiceRoleClient();

  const { data: rawPhotos } = await db
    .from("booking_photos")
    .select(`
      id,
      booking_id,
      storage_path,
      thumbnail_path,
      ai_quality_score,
      ai_detected_style,
      ai_detected_colors,
      customer_rating,
      customer_viewed_at,
      sms_sent_at,
      created_at,
      bookings (
        client_name,
        start_time_utc,
        services!bookings_service_id_fkey ( name ),
        staff ( name )
      )
    `)
    .eq("salon_id", ctx.salon.id)
    .is("deleted_at", null)
    .gte("created_at", ninetyDaysAgo)
    .order("created_at", { ascending: false })
    .limit(200);

  if (!rawPhotos?.length) {
    return (
      <main className="mx-auto w-full max-w-[var(--max-nq-desktop)] px-[var(--pad-nq-section-mobile)] py-6 md:px-6">
        <PhotoGalleryPanel slug={slug} photos={[]} />
      </main>
    );
  }

  // Generate signed URLs for thumbnail or full image (batch, 6h expiry)
  const paths = rawPhotos.map((p) => ({
    id: p.id,
    path: (p.thumbnail_path ?? p.storage_path) as string,
  }));

  const signedResults = await db.storage
    .from("booking-photos")
    .createSignedUrls(paths.map((p) => p.path), 60 * 60 * 6);

  const urlMap: Record<string, string> = {};
  signedResults.data?.forEach((item, idx) => {
    if (item.signedUrl) urlMap[paths[idx].id] = item.signedUrl;
  });

  type BookingRef = {
    client_name: string | null;
    start_time_utc: string | null;
    services: { name: string } | { name: string }[] | null;
    staff: { name: string } | { name: string }[] | null;
  } | null;

  const photos: PhotoRow[] = rawPhotos.map((p) => {
    const booking = (
      Array.isArray(p.bookings) ? p.bookings[0] : p.bookings
    ) as BookingRef;

    const serviceName = booking?.services
      ? Array.isArray(booking.services)
        ? booking.services[0]?.name ?? null
        : booking.services.name
      : null;

    const staffName = booking?.staff
      ? Array.isArray(booking.staff)
        ? booking.staff[0]?.name ?? null
        : booking.staff.name
      : null;

    return {
      id: p.id,
      booking_id: p.booking_id,
      storage_path: p.storage_path,
      thumbnail_path: p.thumbnail_path,
      ai_quality_score: p.ai_quality_score != null ? Number(p.ai_quality_score) : null,
      ai_detected_style: p.ai_detected_style ?? null,
      ai_detected_colors: (p.ai_detected_colors as string[] | null) ?? null,
      customer_rating: p.customer_rating ?? null,
      customer_viewed_at: p.customer_viewed_at ?? null,
      sms_sent_at: p.sms_sent_at ?? null,
      created_at: p.created_at,
      signedUrl: urlMap[p.id] ?? null,
      clientName: booking?.client_name ?? null,
      serviceName,
      staffName,
      appointmentDate: booking?.start_time_utc ?? null,
    };
  });

  return (
    <main className="mx-auto w-full max-w-[var(--max-nq-desktop)] px-[var(--pad-nq-section-mobile)] py-6 md:px-6">
      <PhotoGalleryPanel slug={slug} photos={photos} />
    </main>
  );
}
