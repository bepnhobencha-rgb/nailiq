"use client";

import Link from "next/link";
import { v1AllowsAutomatedSubscriptionBilling } from "@/shared/release/v1IntegrationScope";

type Props = {
  salonName: string;
  offerUrl: string;
};

export function SubscriptionDeadlineNotice({ salonName, offerUrl }: Props) {
  const automatedBilling = v1AllowsAutomatedSubscriptionBilling();
  return (
    <main className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 py-8 backdrop-blur-sm">
      <section
        className="w-full max-w-lg rounded-3xl border border-white/10 bg-[#f4f8f5] p-6 text-[#17201b] shadow-2xl sm:p-8"
        role="dialog"
        aria-modal="true"
        aria-labelledby="subscription-deadline-title"
      >
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[#2d7650]">
          NailIQ · {salonName}
        </p>
        <h1 id="subscription-deadline-title" className="mt-3 text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">
          Subscription required · Cần đăng ký để tiếp tục
        </h1>
        <p className="mt-4 text-sm leading-6 text-black/68">
          {automatedBilling
            ? "Dashboard access is paused. Complete secure payment to restore access automatically. · Dashboard đang tạm khóa. Hoàn tất thanh toán bảo mật để tự động mở lại."
            : "Dashboard access is paused. Contact NailIQ to confirm your subscription and arrange access. Billing is handled with our team. · Dashboard đang tạm khóa. Liên hệ NailIQ để xác nhận gói và hỗ trợ quyền truy cập. Đội ngũ NailIQ hỗ trợ thanh toán trực tiếp."}
        </p>
        <Link
          href={automatedBilling ? offerUrl : "/contact"}
          data-testid="subscription-deadline-next"
          className="mt-7 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-[#153e2a] px-5 py-3 font-semibold text-white"
        >
          {automatedBilling
            ? "Review agreement & pay · Xem hợp đồng và thanh toán"
            : "Contact NailIQ · Liên hệ NailIQ"}
        </Link>
        <p className="mt-4 text-center text-xs leading-5 text-black/45">
          Public website and customer booking remain available · Website và đặt lịch của khách vẫn hoạt động
        </p>
      </section>
    </main>
  );
}
