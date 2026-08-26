import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { GuidedSetupReturnCard } from "@/components/dashboard/GuidedSetupReturnCard";
import { GuidedBookingPreviewSimulator } from "@/components/dashboard/GuidedBookingPreviewSimulator";
import { SetupBackNav } from "@/components/dashboard/SetupBackNav";
import { MobileStack } from "@/components/layout/MobileStack";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { loadGuidedBookingPreview } from "@/shared/dashboard/loadGuidedBookingPreview";
import { resolveUserLanguage } from "@/shared/i18n/user/resolveUserLanguage";

type Props = { params: Promise<{ slug: string }> };

export const metadata: Metadata = {
  title: "Booking Preview · NailIQ",
  description: "Review the public booking experience before go-live.",
};

export default async function GuidedBookingPreviewPage({ params }: Props) {
  const { slug } = await params;
  const preview = await loadGuidedBookingPreview(slug);
  if (!preview.ok && preview.reason === "unauthorized") {
    redirect("/register");
  }
  if (!preview.ok && preview.reason === "disabled") {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }

  const language = await resolveUserLanguage();
  const vi = language === "vi";

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
                  ? "Preview booking không tạo side effect"
                  : "Side-effect-free booking preview"}
              </h1>
              <p className="mt-2 text-sm leading-6 text-nq-muted">
                {vi
                  ? "Dịch vụ, nhân viên và lịch trống được đọc từ cùng nguồn với trang khách. Preview kiểm tra lại dữ liệu trên server nhưng không gọi luồng xác nhận thật."
                  : "Services, staff, and availability come from the same read paths as the customer page. The preview rechecks server data but never calls the live confirmation path."}
              </p>
            </div>
          </div>
        </Card>

        {preview.ok ? (
          <GuidedBookingPreviewSimulator
            data={preview.data}
            language={language}
          />
        ) : (
          <Card variant="bordered" padding="lg">
            <h2 className="text-base font-semibold text-nq-danger">
              {vi ? "Không tải được preview" : "Preview unavailable"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-nq-muted">
              {vi
                ? "Dữ liệu công khai chưa tải đầy đủ. Hệ thống giữ bước này ở trạng thái chưa hoàn tất; không có booking hay thông báo nào được tạo."
                : "The public payload did not load completely. This step remains incomplete, and no booking or notification was created."}
            </p>
          </Card>
        )}

        {preview.ok ? (
          <Card variant="bordered" padding="lg">
            <h2 className="text-base font-semibold text-nq-foreground">
              {vi ? "Sau khi kiểm tra" : "After reviewing"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-nq-muted">
                {vi
                ? "Sau khi chọn một giờ trống, ghi nhận preview ngay trên màn hình này. Bằng chứng được kiểm tra lại trên server và gắn với snapshot cấu hình hiện tại."
                : "After selecting an available time, record the preview on this screen. The server rechecks the evidence and binds it to the current configuration snapshot."}
            </p>
            <a
              href={`/dashboard/${encodeURIComponent(slug)}/settings/readiness`}
              className="mt-4 inline-flex min-h-11 items-center rounded-full bg-nq-primary px-5 text-sm font-semibold text-black"
            >
              {vi ? "Đến Go-Live Readiness" : "Open Go-Live Readiness"}
            </a>
          </Card>
        ) : null}

        <GuidedSetupReturnCard slug={slug} currentStep="booking-preview" />
      </MobileStack>
    </ResponsiveShell>
  );
}
