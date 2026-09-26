import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CancellationFeeAction } from "@/components/dashboard/CancellationFeeAction";
import { Card } from "@/components/ui/Card";
import { loadCancellationFeeEmailReview } from "@/shared/noshow/cancellationFeeEmailActions";

export const metadata: Metadata = {
  title: "Review cancellation fee · NailIQ",
  robots: { index: false, follow: false },
};

export default async function CancellationFeePage({ params }: {
  params: Promise<{ slug: string; bookingId: string }>;
}) {
  const { slug, bookingId } = await params;
  const result = await loadCancellationFeeEmailReview(slug, bookingId);
  if (!result.ok) {
    if (result.error === "not_found" || result.error === "unauthorized") notFound();
    return <div className="mx-auto w-full max-w-xl p-4 sm:p-6"><Card>
      <h1 className="font-semibold text-nq-text">Unable to load fee review · Chưa tải được phiếu phí</h1>
      <p className="mt-2 text-sm text-nq-muted">Reload this page to check the current status. No payment was requested by opening this page.</p>
      <p className="mt-2 text-sm text-nq-muted">Vui lòng tải lại để kiểm tra trạng thái. Mở trang này không gửi yêu cầu thu tiền.</p>
    </Card></div>;
  }
  return <CancellationFeeAction slug={slug} data={result} />;
}
