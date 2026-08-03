"use client";

type Props = {
  salonName: string;
  offerUrl: string;
};

export function SubscriptionDeadlineNotice({ salonName, offerUrl }: Props) {
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
          Dashboard access is paused because the July 31 subscription deadline has passed. Complete secure payment to restore access automatically.
          {" · "}
          Dashboard đang tạm khóa vì hạn đăng ký ngày 31/07 đã qua. Hoàn tất thanh toán bảo mật để tự động mở lại.
        </p>
        <a
          href={offerUrl}
          className="mt-7 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-[#153e2a] px-5 py-3 font-semibold text-white"
        >
          Review agreement &amp; pay · Xem hợp đồng và thanh toán
        </a>
        <p className="mt-4 text-center text-xs leading-5 text-black/45">
          Public website and customer booking remain available · Website và đặt lịch của khách vẫn hoạt động
        </p>
      </section>
    </main>
  );
}
