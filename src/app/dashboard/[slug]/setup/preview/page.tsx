import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ShieldAlert } from "lucide-react";
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
              <ShieldAlert className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h1 className="text-xl font-semibold text-nq-foreground">
                {vi
                  ? "Bản tóm tắt chỉ đọc"
                  : "Read-only setup summary"}
              </h1>
              <p className="mt-2 text-sm leading-6 text-nq-muted">
                {vi
                  ? "Vì form booking công khai có thể tạo lịch, thu thập thẻ hoặc gửi thông báo, prototype này không mở form đó. Bước chạy thử vẫn ở trạng thái cần kiểm tra."
                  : "The public booking form can create appointments, collect card details, or send notifications, so this prototype does not open it. Rehearsal remains Needs Review."}
              </p>
            </div>
          </div>

          <ul className="mt-5 space-y-2 text-sm leading-6 text-nq-muted">
            <li>
              •{" "}
              {vi
                ? `Tên salon: ${ctx.salon.name || "Chưa có"}`
                : `Salon name: ${ctx.salon.name || "Missing"}`}
            </li>
            <li>
              •{" "}
              {vi
                ? `Địa chỉ: ${ctx.salon.address || "Chưa có"}`
                : `Address: ${ctx.salon.address || "Missing"}`}
            </li>
            <li>
              •{" "}
              {vi
                ? `Điện thoại công khai: ${ctx.salon.salon_phone || "Chưa có"}`
                : `Public phone: ${ctx.salon.salon_phone || "Missing"}`}
            </li>
          </ul>
        </Card>

        <Card variant="bordered" padding="lg">
          <h2 className="text-base font-semibold text-nq-foreground">
            {vi ? "Sau khi xem xong" : "After your review"}
          </h2>
          <p className="mt-2 text-sm leading-6 text-nq-muted">
            {vi
              ? "Cần thiết kế riêng chế độ preview được xác thực và không tạo booking, thanh toán hay thông báo. Cho đến lúc đó, Guided Setup không thể hiển thị Sẵn sàng hoạt động."
              : "A separate authenticated preview that cannot create bookings, payments, or notifications is required. Until then, Guided Setup cannot report Ready."}
          </p>
        </Card>

        <GuidedSetupReturnCard slug={slug} currentStep="booking-preview" />
      </MobileStack>
    </ResponsiveShell>
  );
}
