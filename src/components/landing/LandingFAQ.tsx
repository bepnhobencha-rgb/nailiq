"use client";

import Link from "next/link";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

const FAQ = {
  en: [
    ["Do I need a credit card to start?", "No. Your 14-day trial starts after you create your salon workspace. You choose whether to subscribe later."],
    ["What happens after 14 days?", "Paid features pause until you choose a plan. We keep your salon data so you can continue without setting everything up again."],
    ["Do I have to replace Square or Clover?", "No. NailIQ handles booking and salon operations alongside your existing POS."],
    ["Can NailIQ set everything up for me?", "Yes. Done-for-you setup is optional and quoted separately based on your salon's data and needs."],
    ["Can I use NailIQ in Vietnamese?", "Yes. Owner-facing areas support English and Vietnamese, and our team can assist in Vietnamese."],
    ["How quickly can I try it?", "Most owners can create a workspace in about two minutes, then add services, staff and business hours from the setup checklist."],
    ["Can I cancel?", "Yes. You can cancel your paid subscription without a cancellation fee."],
  ],
  vi: [
    ["Có cần thẻ tín dụng để bắt đầu không?", "Không. Thời gian dùng thử 14 ngày bắt đầu sau khi bạn tạo không gian cho tiệm. Sau đó bạn mới quyết định có đăng ký trả phí hay không."],
    ["Sau 14 ngày sẽ thế nào?", "Các tính năng trả phí sẽ tạm dừng cho tới khi bạn chọn gói. Dữ liệu tiệm vẫn được giữ để bạn không phải cài đặt lại từ đầu."],
    ["Có phải bỏ Square hoặc Clover không?", "Không. NailIQ quản lý booking và vận hành tiệm song song với POS hiện tại."],
    ["NailIQ có thể setup mọi thứ giúp tôi không?", "Có. Dịch vụ setup trọn gói là lựa chọn thêm và được báo giá theo dữ liệu cùng nhu cầu thực tế của tiệm."],
    ["Có dùng bằng tiếng Việt được không?", "Có. Khu vực dành cho chủ tiệm hỗ trợ tiếng Anh và tiếng Việt; đội NailIQ cũng có thể hỗ trợ bằng tiếng Việt."],
    ["Bao lâu thì bắt đầu dùng được?", "Phần lớn chủ tiệm có thể tạo không gian trong khoảng hai phút, rồi thêm dịch vụ, nhân viên và giờ mở cửa theo checklist."],
    ["Tôi có thể hủy không?", "Có. Bạn có thể hủy gói trả phí mà không có phí hủy."],
  ],
} as const;

export function LandingFAQ() {
  const { language } = useUserLanguage();
  const items = FAQ[language].slice(0, 4);

  return (
    <section id="faq" className="bg-nq-bg py-14 md:py-20">
      <div className="mx-auto w-full max-w-3xl px-5 md:px-8">
        <div className="text-center">
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-nq-primary">FAQ</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-nq-foreground md:text-5xl">
            {language === "vi" ? "Câu hỏi trước khi bắt đầu" : "Questions before you start"}
          </h2>
        </div>
        <ul className="mt-10 space-y-3">
          {items.map(([question, answer]) => (
            <li key={question}>
              <details className="group rounded-2xl border border-nq-border/40 bg-nq-surface/40 px-5 py-4 open:border-nq-primary/40 md:px-6 md:py-5">
                <summary className="flex cursor-pointer list-none justify-between gap-4 text-base font-medium text-nq-foreground md:text-lg">
                  <span>{question}</span><span aria-hidden className="text-nq-primary group-open:rotate-45">+</span>
                </summary>
                <p className="mt-4 text-sm leading-relaxed text-nq-muted md:text-base">{answer}</p>
              </details>
            </li>
          ))}
        </ul>
        <p className="mt-10 text-center text-sm text-nq-muted">
          {language === "vi" ? "Vẫn còn câu hỏi? " : "Still have questions? "}
          <Link href="/contact" className="font-semibold text-nq-primary-soft hover:underline">
            {language === "vi" ? "Liên hệ NailIQ" : "Contact NailIQ"}
          </Link>
        </p>
      </div>
    </section>
  );
}
