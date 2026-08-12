"use client";

import Link from "next/link";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import {
  PUBLIC_SUBSCRIPTION_PRICES,
  PUBLIC_TRIAL_DAYS,
  formatPublicMonthlyPrice,
} from "@/shared/subscriptions/pricingCatalog";

export function LandingPricing() {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const core = PUBLIC_SUBSCRIPTION_PRICES.pro;

  const coreFeatures = vi
    ? [
        "Trang đặt lịch online cho tiệm",
        "Lịch nhân viên và quầy lễ tân trực tuyến",
        "Quản lý dịch vụ, khách hàng và báo cáo",
        "Dùng cùng Square, Clover hoặc POS hiện tại",
        "Hỗ trợ tiếng Việt và tiếng Anh",
      ]
    : [
        "Online booking page for your salon",
        "Staff scheduling and live front desk",
        "Services, customers and reporting",
        "Works alongside Square, Clover or your current POS",
        "English and Vietnamese support",
      ];

  return (
    <section className="bg-nq-bg py-14 md:py-20" id="pricing">
      <div className="mx-auto w-full max-w-5xl px-5 md:px-8">
        <div className="text-center">
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-nq-primary">
            {vi ? "Giá rõ ràng" : "Simple pricing"}
          </p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-nq-foreground md:text-5xl">
            {vi ? "Tự thử trước. Chỉ trả tiền khi phù hợp." : "Try it first. Pay only when it fits."}
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-base text-nq-muted md:text-lg">
            {vi
              ? `${PUBLIC_TRIAL_DAYS} ngày miễn phí, không cần thẻ tín dụng. Bạn có thể tự cài đặt hoặc nhờ NailIQ làm giúp.`
              : `${PUBLIC_TRIAL_DAYS} days free with no credit card. Set it up yourself or have NailIQ do it for you.`}
          </p>
        </div>

        <div className="mt-12 grid gap-6 md:grid-cols-2">
          <article className="flex flex-col rounded-3xl border-2 border-nq-primary/60 bg-nq-surface/60 p-7 shadow-[0_24px_70px_-35px_rgba(212,175,55,0.55)] md:p-9">
            <span className="w-fit rounded-full bg-nq-primary/15 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-nq-primary">
              {vi
                ? `Dùng thử ${PUBLIC_TRIAL_DAYS} ngày`
                : `${PUBLIC_TRIAL_DAYS}-day free trial`}
            </span>
            <h3 className="mt-5 text-xl font-semibold text-nq-foreground">
              NailIQ {core.marketingName}
            </h3>
            <div className="mt-3 flex items-end gap-2">
              <span className="text-5xl font-bold text-nq-foreground">
                {formatPublicMonthlyPrice("pro")}
              </span>
              <span className="pb-1 text-sm text-nq-muted">
                {core.currency} / {vi ? "tháng" : core.interval}
              </span>
            </div>
            <p className="mt-2 text-sm text-nq-muted">
              {vi ? "Không phí setup nếu bạn tự cài đặt." : "No setup fee when you set it up yourself."}
            </p>
            <ul className="mt-7 flex-1 space-y-3">
              {coreFeatures.map((feature) => (
                <li key={feature} className="flex gap-3 text-sm text-nq-foreground">
                  <span aria-hidden className="text-nq-primary">✓</span>
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
            <Link
              href="/register?intent=trial"
              data-testid="pricing-cta-trial"
              className="mt-8 inline-flex min-h-12 items-center justify-center rounded-full bg-nq-primary px-6 font-semibold text-nq-bg transition hover:brightness-105"
            >
              {vi ? "Bắt đầu dùng thử miễn phí" : "Start free trial"}
            </Link>
            <p className="mt-3 text-center text-xs text-nq-muted">
              {vi ? "Không cần thẻ · Hủy bất cứ lúc nào" : "No card required · Cancel anytime"}
            </p>
          </article>

          <article className="flex flex-col rounded-3xl border border-nq-border/40 bg-nq-surface/35 p-7 md:p-9">
            <span className="w-fit rounded-full border border-nq-border/50 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-nq-muted">
              {vi ? "Dịch vụ tùy chọn" : "Optional service"}
            </span>
            <h3 className="mt-5 text-xl font-semibold text-nq-foreground">
              {vi ? "NailIQ setup giúp" : "Done-for-you setup"}
            </h3>
            <p className="mt-4 text-base leading-relaxed text-nq-muted">
              {vi
                ? "Dành cho chủ tiệm bận hoặc không muốn tự nhập dữ liệu. Chúng tôi giúp đưa dịch vụ, nhân viên, giờ mở cửa và website của bạn lên NailIQ."
                : "For busy owners who do not want to enter everything themselves. We help move your services, staff, hours and website into NailIQ."}
            </p>
            <ul className="mt-7 flex-1 space-y-3 text-sm text-nq-foreground">
              <li>✓ {vi ? "Nhập dữ liệu và cấu hình tiệm" : "Salon data import and configuration"}</li>
              <li>✓ {vi ? "Đào tạo online cho chủ tiệm" : "Online owner training"}</li>
              <li>✓ {vi ? "Hỗ trợ kiểm tra trước go-live" : "Pre-launch verification support"}</li>
              <li>✓ {vi ? "Báo giá theo phạm vi thực tế" : "Quoted to match the actual scope"}</li>
            </ul>
            <Link
              href="/contact?intent=setup"
              data-testid="pricing-cta-setup"
              className="mt-8 inline-flex min-h-12 items-center justify-center rounded-full border border-nq-primary/45 px-6 font-semibold text-nq-foreground transition hover:bg-nq-primary/10"
            >
              {vi ? "Nhờ NailIQ setup giúp" : "Get setup help"}
            </Link>
          </article>
        </div>
      </div>
    </section>
  );
}
