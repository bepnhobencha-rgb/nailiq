import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ExternalLink, ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { GuidedSetupReturnCard } from "@/components/dashboard/GuidedSetupReturnCard";
import { SetupBackNav } from "@/components/dashboard/SetupBackNav";
import { MobileStack } from "@/components/layout/MobileStack";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isReleaseFeatureEnabled } from "@/shared/features/featureRegistry";
import { resolveUserLanguage } from "@/shared/i18n/user/resolveUserLanguage";

type Props = { params: Promise<{ slug: string }> };

export const metadata: Metadata = {
  title: "Booking Preview · NailIQ",
  description: "Review the public booking experience before go-live.",
};

export default async function GuidedBookingPreviewPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");
  if (ctx.role !== "owner" && ctx.role !== "admin") {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }
  if (!isReleaseFeatureEnabled(ctx.salon, "guided_admin_setup")) {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }

  const language = await resolveUserLanguage();
  const vi = language === "vi";
  const publicBookingHref = `/${encodeURIComponent(slug)}`;
  const readinessHref = `/dashboard/${encodeURIComponent(slug)}/settings/readiness`;

  return (
    <ResponsiveShell>
      <MobileStack className="min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 sm:pt-6">
        <SetupBackNav
          slug={slug}
          title={vi ? "Xem trước trang đặt lịch" : "Preview booking page"}
          backHref={`/dashboard/${encodeURIComponent(slug)}/setup`}
          backLabel="← Setup"
        />

        <Card
          variant="elevated"
          padding="lg"
          data-testid="guided-booking-preview"
        >
          <div className="flex items-start gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-nq-success/15 text-nq-success">
              <ShieldCheck className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h1 className="text-xl font-semibold text-nq-foreground">
                {vi
                  ? "Kiểm tra như một khách thật"
                  : "Review it like a customer"}
              </h1>
              <p className="mt-2 text-sm leading-6 text-nq-muted">
                {vi
                  ? "Trang xem trước dùng đúng dữ liệu salon đã lưu. Chỉ xem và đi qua các bước — không xác nhận lịch hẹn, không gửi tin và không nhập thẻ thật."
                  : "The preview uses the salon’s saved data. Review the steps only — do not confirm an appointment, send a message, or enter a real card."}
              </p>
            </div>
          </div>

          <ul className="mt-5 space-y-2 text-sm leading-6 text-nq-muted">
            <li>
              •{" "}
              {vi
                ? "Tên, ngôn ngữ và thương hiệu đúng"
                : "Name, language, and branding are correct"}
            </li>
            <li>
              •{" "}
              {vi
                ? "Dịch vụ, giá và thời lượng dễ hiểu"
                : "Services, prices, and duration are clear"}
            </li>
            <li>
              •{" "}
              {vi
                ? "Ngày giờ và chính sách hiển thị đúng"
                : "Availability and policies display correctly"}
            </li>
          </ul>

          <Link
            href={publicBookingHref}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="guided-open-public-booking"
            className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-nq-primary px-4 text-base font-semibold text-nq-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary"
          >
            {vi
              ? "Mở trang booking ở tab mới"
              : "Open booking page in a new tab"}
            <ExternalLink className="h-4 w-4" aria-hidden />
          </Link>
        </Card>

        <Card variant="bordered" padding="lg">
          <h2 className="text-base font-semibold text-nq-foreground">
            {vi ? "Sau khi xem xong" : "After your review"}
          </h2>
          <p className="mt-2 text-sm leading-6 text-nq-muted">
            {vi
              ? "Quay lại đây và mở Go-Live Readiness để ghi nhận lần chạy thử. NailIQ chỉ xem bước này là hoàn tất sau khi người có quyền xác nhận."
              : "Return here and open Go-Live Readiness to record the rehearsal. NailIQ only completes this step after an authorized human confirms it."}
          </p>
          <Link
            href={readinessHref}
            data-testid="guided-preview-continue"
            className="mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-full border border-nq-border px-4 text-base font-semibold text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary"
          >
            {vi
              ? "Tiếp tục đến Go-Live Readiness"
              : "Continue to Go-Live Readiness"}
          </Link>
        </Card>

        <GuidedSetupReturnCard slug={slug} />
      </MobileStack>
    </ResponsiveShell>
  );
}
