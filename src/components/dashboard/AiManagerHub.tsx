"use client";

import { useState, useTransition } from "react";
import { updateAiAgentFlag } from "@/shared/dashboard/salonOwnerActions";
import type { AiAgentFlagKey, AiAgentFlags } from "@/shared/dashboard/aiAgentTypes";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Props = {
  slug: string;
  initialFlags: AiAgentFlags;
};

type AgentDef = {
  key: AiAgentFlagKey;
  icon: string;
  nameEn: string;
  nameVi: string;
  descEn: string;
  descVi: string;
};

const AGENTS: AgentDef[] = [
  {
    key: "ai_noshow_policy_live",
    icon: "🤖",
    nameEn: "Người Gác Cửa — No-show Guard",
    nameVi: "Người Gác Cửa — Kiểm soát no-show",
    descEn:
      "AI decides per booking whether to require a card on file or deposit — based on the guest's history. Replaces one-size-fits-all rules.",
    descVi:
      "AI quyết định từng booking có cần giữ thẻ hoặc đặt cọc không — dựa vào lịch sử khách. Thay thế quy tắc cứng áp dụng cho tất cả.",
  },
  {
    key: "ai_watchdog",
    icon: "📡",
    nameEn: "Radar — Operational watchdog",
    nameVi: "Radar — Cảnh báo vận hành",
    descEn:
      "Scans your schedule daily and alerts you to problems before they escalate: no-show spikes, slow booking days, team conflicts.",
    descVi:
      "Quét lịch hàng ngày, cảnh báo sớm trước khi vấn đề leo thang: tỷ lệ no-show tăng, ngày ít lịch, xung đột nhóm.",
  },
  {
    key: "ai_winback",
    icon: "🔄",
    nameEn: "Người Kéo Về — Win-back",
    nameVi: "Người Kéo Về — Kéo khách trở lại",
    descEn:
      'Drafts a friendly "we miss you" email for guests who haven\'t returned in 60+ days — with a one-tap rebook link.',
    descVi:
      'Soạn email thân thiện "tụi mình nhớ bạn" cho khách trên 60 ngày chưa quay lại, kèm link đặt lịch 1 chạm.',
  },
  {
    key: "ai_rebook",
    icon: "⏰",
    nameEn: "Nhịp Tim — Rebook nudge",
    nameVi: "Nhịp Tim — Nhắc đặt lại",
    descEn:
      "Identifies regulars who are due for their next visit based on their usual rhythm and nudges them before they forget.",
    descVi:
      "Nhận ra khách quen sắp đến lịch theo chu kỳ thường lệ, nhắc họ trước khi họ quên.",
  },
  {
    key: "ai_smart_reminders",
    icon: "💬",
    nameEn: "Người Nhắc Hẹn — Smart reminders",
    nameVi: "Người Nhắc Hẹn — Nhắc hẹn thông minh",
    descEn:
      "Personalizes the opening line of SMS reminders with the guest's name and service. Feels like a note from a person, not a bot.",
    descVi:
      "Cá nhân hóa dòng đầu SMS nhắc hẹn với tên và dịch vụ của khách. Cảm giác như tin nhắn từ người quen, không phải bot.",
  },
  {
    key: "ai_social_content",
    icon: "📸",
    nameEn: "Social Content — Caption drafts",
    nameVi: "Social Content — Soạn caption",
    descEn:
      "Drafts Instagram/Facebook captions on Mon/Wed/Fri at 8am based on your recent bookings and seasonal trends.",
    descVi:
      "Soạn caption Instagram/Facebook vào thứ 2/4/6 lúc 8 giờ sáng, dựa trên lịch hẹn gần đây và xu hướng theo mùa.",
  },
  {
    key: "ai_vip_care",
    icon: "👑",
    nameEn: "VIP Care — Milestone moments",
    nameVi: "VIP Care — Khoảnh khắc đặc biệt",
    descEn:
      "Spots birthdays, anniversaries, and loyalty milestones — then drafts a warm personal note so your best guests feel seen.",
    descVi:
      "Nhận ra sinh nhật, kỷ niệm, cột mốc trung thành — soạn lời chúc ấm áp để khách VIP cảm thấy được trân trọng.",
  },
  {
    key: "ai_first_visit_nurture",
    icon: "🌱",
    nameEn: "First Visit → Second Visit",
    nameVi: "Lần đầu → Lần hai",
    descEn:
      "80% of first-time clients never return. This agent follows up with 3 warm, personalised touchpoints to turn new guests into regulars — and stops the moment they rebook.",
    descVi:
      "80% khách lần đầu không quay lại. Agent này gửi 3 tin nhắn ấm áp, cá nhân hóa để biến khách mới thành khách quen — và tự dừng ngay khi họ đặt lại.",
  },
  {
    key: "ai_unified_digest",
    icon: "📋",
    nameEn: "Unified Daily Digest",
    nameVi: "Bản tổng kết cuối ngày",
    descEn:
      "Replaces all individual agent emails with one cohesive end-of-day briefing in the Manager's voice: what happened, what AI did, what to watch tomorrow.",
    descVi:
      "Gộp tất cả email riêng lẻ từ các agent thành 1 bản tổng kết duy nhất lúc 21:00, viết bằng giọng Quản Lý: hôm nay thế nào, AI đã làm gì, ngày mai cần chú ý gì.",
  },
];

function AgentToggle({
  slug,
  agent,
  initialEnabled,
  vi,
}: {
  slug: string;
  agent: AgentDef;
  initialEnabled: boolean;
  vi: boolean;
}) {
  const [on, setOn] = useState(initialEnabled);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !on;
    setOn(next);
    startTransition(async () => {
      const res = await updateAiAgentFlag(slug, agent.key, next);
      if (!res.ok) setOn(!next);
    });
  }

  return (
    <div className="flex items-start justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-nq-foreground">
          <span className="mr-1.5" aria-hidden>
            {agent.icon}
          </span>
          {vi ? agent.nameVi : agent.nameEn}
        </p>
        <p className="mt-0.5 text-xs text-nq-muted">
          {vi ? agent.descVi : agent.descEn}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={vi ? agent.nameVi : agent.nameEn}
        disabled={pending}
        onClick={toggle}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
          on ? "bg-nq-primary" : "bg-white/15"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
            on ? "translate-x-5" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}

export function AiManagerHub({ slug, initialFlags }: Props) {
  const { language } = useUserLanguage();
  const vi = language === "vi";

  return (
    <section
      data-testid="settings-ai-manager-hub"
      className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
    >
      <p className="mb-1 text-xs font-medium uppercase tracking-wider text-nq-muted">
        {vi ? "AI Quản Lý" : "AI Manager"}
      </p>
      <p className="mb-4 text-xs text-nq-muted">
        {vi
          ? "Bật/tắt từng agent AI. Mỗi agent tự điều tiết — bật an toàn mà không lo spam."
          : "Toggle each AI agent on or off. Every agent self-throttles — safe to enable without risk of over-messaging."}
      </p>

      <div className="divide-y divide-nq-border/20">
        {AGENTS.map((agent) => (
          <AgentToggle
            key={agent.key}
            slug={slug}
            agent={agent}
            initialEnabled={initialFlags[agent.key] ?? false}
            vi={vi}
          />
        ))}
      </div>
    </section>
  );
}
