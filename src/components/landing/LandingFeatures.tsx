"use client";

import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

export function LandingFeatures() {
  const reduce = useReducedMotion();
  const { language } = useUserLanguage();
  const isVi = language === "vi";
  const essentials = isVi
    ? [
        { icon: "📅", title: "Đặt lịch dễ dàng", body: "Khách tự đặt 24/7. Lễ tân thấy ngay lịch hôm nay." },
        { icon: "✨", title: "Quầy lễ tân rõ ràng", body: "Check-in, lịch hẹn và khách hàng ở một nơi." },
        { icon: "📱", title: "Chủ tiệm dùng tốt trên iPhone", body: "Xem tình hình tiệm và xử lý việc quan trọng chỉ với vài chạm." },
      ]
    : [
        { icon: "📅", title: "Easy booking", body: "Clients book 24/7. Your front desk sees today at a glance." },
        { icon: "✨", title: "A clear front desk", body: "Check-in, appointments and clients in one simple place." },
        { icon: "📱", title: "Great on an iPhone", body: "Owners can see the salon and act on what matters in a few taps." },
      ];

  return (
    <section className="relative bg-nq-bg py-14 md:py-20">
      <div className="mx-auto w-full max-w-6xl px-5 md:px-8">
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        >
          <p className="text-[11px] font-semibold tracking-[0.24em] text-nq-primary uppercase">
            {isVi ? "Ba việc quan trọng" : "Three things that matter"}
          </p>
          <h2 className="mt-4 max-w-3xl text-3xl font-semibold tracking-tight text-nq-foreground md:text-4xl lg:text-5xl">
            {isVi ? "NailIQ giúp tiệm vận hành nhẹ nhàng hơn." : "NailIQ makes the salon feel easier to run."}
          </h2>
        </motion.div>

        <div className="mt-10 grid gap-4 md:grid-cols-3 md:gap-5">
          {essentials.map((item, i) => (
            <motion.article
              key={item.title}
              initial={reduce ? false : { opacity: 0, y: 24 }}
              whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{
                duration: 0.5,
                delay: 0.04 + (i % 3) * 0.05,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="nq-feature-card group relative flex flex-col p-6 md:p-7"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-nq-primary/30 bg-nq-primary/10 text-xl">
                <span aria-hidden>{item.icon}</span>
              </div>
              <h3 className="mt-5 text-lg font-semibold text-nq-foreground md:text-xl">
                {item.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-nq-muted/85">
                {item.body}
              </p>
            </motion.article>
          ))}
        </div>
      </div>
    </section>
  );
}
