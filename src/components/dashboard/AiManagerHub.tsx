"use client";

import Link from "next/link";
import { useState, useTransition, useRef, useCallback } from "react";
import { updateAiAgentFlag, updateAiManagerInstructions, updateOwnerNotificationSettings } from "@/shared/dashboard/salonOwnerActions";
import {
  AI_AGENT_IMPACT,
  requiresAiAgentEnableAcknowledgement,
  type AiAgentFlagKey,
  type AiAgentFlags,
  type AiAgentImpact,
} from "@/shared/dashboard/aiAgentTypes";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Props = {
  slug: string;
  initialFlags: AiAgentFlags;
  initialInstructions?: string | null;
  initialNotifChannel?: "email" | "sms" | "both";
  initialOwnerPhone?: string;
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
      'Automatically sends a capped "we miss you" SMS or email to eligible, consented guests who have not returned in 60+ days.',
    descVi:
      'Tự động gửi tối đa theo giới hạn tin SMS hoặc email "tụi mình nhớ bạn" cho khách đủ điều kiện, đã đồng ý nhận tin và trên 60 ngày chưa quay lại.',
  },
  {
    key: "ai_rebook",
    icon: "⏰",
    nameEn: "Nhịp Tim — Rebook nudge",
    nameVi: "Nhịp Tim — Nhắc đặt lại",
    descEn:
      "Identifies consented regulars due for their next visit and automatically sends a capped SMS or email rebook nudge.",
    descVi:
      "Nhận ra khách quen đã đồng ý nhận tin và đến chu kỳ quay lại, rồi tự động gửi SMS hoặc email nhắc đặt lịch theo giới hạn.",
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
      "Spots birthdays and loyalty milestones, then automatically sends eligible VIP guests a capped personal SMS or email.",
    descVi:
      "Nhận ra sinh nhật và cột mốc trung thành, rồi tự động gửi SMS hoặc email cá nhân theo giới hạn cho khách VIP đủ điều kiện.",
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
      "Gộp tất cả email riêng lẻ từ các agent thành 1 bản tổng kết duy nhất lúc 21:00, viết bằng giọng Minh: hôm nay thế nào, AI đã làm gì, ngày mai cần chú ý gì.",
  },
  {
    key: "ai_gbp_post",
    icon: "📍",
    nameEn: "Google Business Posts — GBP drafts",
    nameVi: "Google Business — Bài đăng tự động",
    descEn:
      "On the 1st and 15th of each month, Minh drafts a ready-to-post Google Business Profile update — tailored to your services, season, and brand voice. Copy-paste in 30 seconds.",
    descVi:
      "Ngày 1 và 15 hàng tháng, Minh soạn sẵn bài đăng Google Business Profile — theo dịch vụ, mùa vụ, và giọng thương hiệu của bạn. Copy-paste trong 30 giây.",
  },
  {
    key: "ai_yelp_reply",
    icon: "⭐",
    nameEn: "Yelp Review Responder",
    nameVi: "Reply Yelp tự động",
    descEn:
      "Minh monitors Yelp every 4 hours and drafts personalised replies for new reviews — 4–5★ sent as copy-paste drafts, 1–3★ flagged with a suggested de-escalation response.",
    descVi:
      "Minh theo dõi Yelp mỗi 4 tiếng, soạn reply cá nhân hoá cho review mới — 4–5★ gửi nháp copy-paste, 1–3★ cảnh báo kèm reply xử lý tinh tế.",
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
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    const next = !on;
    const needsAcknowledgement =
      next && requiresAiAgentEnableAcknowledgement(agent.key);
    if (needsAcknowledgement) {
      const impact = AI_AGENT_IMPACT[agent.key];
      const confirmed = window.confirm(
        impact === "booking_policy"
          ? vi
            ? "Agent này có thể thay đổi việc booking mới cần giữ thẻ hoặc đặt cọc. Bạn có chắc muốn bật?"
            : "This agent can change whether new bookings require a card on file or deposit. Enable it?"
          : vi
            ? "Agent này có thể tự động gửi SMS hoặc email cho khách đủ điều kiện theo cài đặt đồng ý nhận tin và giới hạn hiện có. Bạn có chắc muốn bật?"
            : "This agent can automatically send SMS or email to eligible customers under existing consent and delivery limits. Enable it?",
      );
      if (!confirmed) return;
    }

    setError(null);
    setOn(next);
    startTransition(async () => {
      const res = await updateAiAgentFlag(slug, agent.key, next, {
        impactAcknowledged: needsAcknowledgement,
      });
      if (!res.ok) {
        setOn(!next);
        setError(
          vi
            ? "Không thể thay đổi agent. Hãy tải lại và thử lần nữa."
            : "The agent setting could not be changed. Refresh and try again.",
        );
      }
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
        <ImpactBadge impact={AI_AGENT_IMPACT[agent.key]} vi={vi} />
        {error ? (
          <p role="alert" className="mt-1 text-xs text-nq-error">
            {error}
          </p>
        ) : null}
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

function ImpactBadge({
  impact,
  vi,
}: {
  impact: AiAgentImpact;
  vi: boolean;
}) {
  const copy: Record<AiAgentImpact, { en: string; vi: string }> = {
    booking_policy: {
      en: "Changes booking protection",
      vi: "Thay đổi bảo vệ booking",
    },
    customer_outreach: {
      en: "Can message customers automatically",
      vi: "Có thể tự động nhắn khách",
    },
    owner_notification: {
      en: "Messages owner only",
      vi: "Chỉ gửi cho chủ tiệm",
    },
    draft_only: {
      en: "Draft only",
      vi: "Chỉ tạo bản nháp",
    },
    monitoring: {
      en: "Monitor and alert",
      vi: "Theo dõi và cảnh báo",
    },
  };
  return (
    <span
      data-impact={impact}
      className="mt-1.5 inline-flex rounded-full border border-nq-border/50 px-2 py-0.5 text-[11px] font-medium text-nq-muted"
    >
      {vi ? copy[impact].vi : copy[impact].en}
    </span>
  );
}

function NotificationSettingsField({
  slug,
  initialChannel,
  initialPhone,
  vi,
}: {
  slug: string;
  initialChannel: "email" | "sms" | "both";
  initialPhone: string;
  vi: boolean;
}) {
  const [channel, setChannel] = useState<"email" | "sms" | "both">(initialChannel);
  const [phone, setPhone] = useState(initialPhone);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, startTransition] = useTransition();

  const save = useCallback(
    (ch: "email" | "sms" | "both", ph: string) => {
      setStatus("saving");
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        startTransition(async () => {
          const res = await updateOwnerNotificationSettings(slug, { channel: ch, phone: ph });
          setStatus(res.ok ? "saved" : "error");
          setTimeout(() => setStatus("idle"), 2000);
        });
      }, 800);
    },
    [slug],
  );

  const CHANNELS: { value: "email" | "sms" | "both"; labelVi: string; labelEn: string }[] = [
    { value: "email", labelVi: "Email", labelEn: "Email" },
    { value: "sms", labelVi: "SMS", labelEn: "SMS" },
    { value: "both", labelVi: "Cả hai", labelEn: "Both" },
  ];

  return (
    <div className="mt-4 border-t border-nq-border/20 pt-4">
      <p className="mb-1 text-xs font-semibold text-nq-foreground">
        {vi ? "📬 Kênh nhận báo cáo từ Minh" : "📬 How Minh reaches you"}
      </p>
      <p className="mb-3 text-xs text-nq-muted">
        {vi
          ? "Minh gửi digest, cảnh báo và tin ACT+UNDO qua kênh này."
          : "Minh sends daily digests, alerts, and ACT+UNDO notifications via this channel."}
      </p>

      <div className="mb-3 flex gap-2">
        {CHANNELS.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => {
              setChannel(c.value);
              save(c.value, phone);
            }}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              channel === c.value
                ? "border-nq-primary bg-nq-primary/10 text-nq-primary"
                : "border-nq-border/30 text-nq-muted hover:border-nq-primary/30 hover:text-nq-foreground"
            }`}
          >
            {vi ? c.labelVi : c.labelEn}
          </button>
        ))}
      </div>

      {(channel === "sms" || channel === "both") && (
        <input
          type="tel"
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
            save(channel, e.target.value);
          }}
          placeholder={vi ? "+1 (604) 555-0100" : "+1 (604) 555-0100"}
          className="w-full rounded-lg border border-nq-border/30 bg-nq-surface/50 px-3 py-2 text-xs text-nq-foreground placeholder:text-nq-muted/50 focus:outline-none focus:ring-1 focus:ring-nq-primary/50"
        />
      )}

      <div className="mt-1 flex justify-end">
        <span
          className={`text-xs transition-opacity ${status === "idle" ? "opacity-0" : "opacity-100"} ${
            status === "saved" ? "text-green-400" : status === "error" ? "text-red-400" : "text-nq-muted"
          }`}
        >
          {status === "saving"
            ? (vi ? "Đang lưu..." : "Saving...")
            : status === "saved"
              ? (vi ? "Đã lưu ✓" : "Saved ✓")
              : status === "error"
                ? (vi ? "Lỗi lưu" : "Save failed")
                : ""}
        </span>
      </div>
    </div>
  );
}

function InstructionsField({
  slug,
  initialValue,
  vi,
}: {
  slug: string;
  initialValue: string;
  vi: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, startTransition] = useTransition();

  const save = useCallback(
    (text: string) => {
      setStatus("saving");
      startTransition(async () => {
        const res = await updateAiManagerInstructions(slug, text);
        setStatus(res.ok ? "saved" : "error");
        setTimeout(() => setStatus("idle"), 2000);
      });
    },
    [slug],
  );

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setValue(v);
    setStatus("idle");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => save(v), 1000);
  }

  const remaining = 1000 - value.length;

  return (
    <div className="mt-4 border-t border-nq-border/20 pt-4">
      <p className="mb-1 text-xs font-semibold text-nq-foreground">
        {vi ? "🎯 Chỉ đạo cho Minh" : "🎯 Instructions for Minh"}
      </p>
      <p className="mb-2 text-xs text-nq-muted">
        {vi
          ? "Mục tiêu, ưu tiên, hoặc ràng buộc bạn muốn Minh ghi nhớ khi làm việc."
          : "Goals, priorities, or constraints you want Minh to keep in mind."}
      </p>
      <textarea
        value={value}
        onChange={handleChange}
        maxLength={1000}
        rows={3}
        placeholder={
          vi
            ? "VD: Tháng 7 tập trung head spa. Ưu tiên khách lần đầu. Không nhắn SMS cuối tuần."
            : "E.g. July focus: head spa. Prioritise first-time guests. No SMS on weekends."
        }
        className="w-full resize-none rounded-lg border border-nq-border/30 bg-nq-surface/50 px-3 py-2 text-xs text-nq-foreground placeholder:text-nq-muted/50 focus:outline-none focus:ring-1 focus:ring-nq-primary/50"
      />
      <div className="mt-1 flex items-center justify-between">
        <span className="text-xs text-nq-muted/60">
          {remaining} {vi ? "ký tự còn lại" : "chars left"}
        </span>
        <span
          className={`text-xs transition-opacity ${
            status === "idle" ? "opacity-0" : "opacity-100"
          } ${
            status === "saved"
              ? "text-green-400"
              : status === "error"
                ? "text-red-400"
                : "text-nq-muted"
          }`}
        >
          {status === "saving"
            ? (vi ? "Đang lưu..." : "Saving...")
            : status === "saved"
              ? (vi ? "Đã lưu ✓" : "Saved ✓")
              : status === "error"
                ? (vi ? "Lỗi lưu" : "Save failed")
                : ""}
        </span>
      </div>
    </div>
  );
}

export function AiManagerHub({ slug, initialFlags, initialInstructions, initialNotifChannel = "email", initialOwnerPhone = "" }: Props) {
  const { language } = useUserLanguage();
  const vi = language === "vi";

  return (
    <section
      data-testid="settings-ai-manager-hub"
      className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
    >
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-nq-muted">
            {vi ? "Minh — AI Quản Lý" : "Minh — AI Manager"}
          </p>
          <p className="mt-0.5 text-xs text-nq-muted">
            {vi
              ? "Mỗi agent ghi rõ phạm vi tác động. Agent có thể nhắn khách hoặc thay đổi bảo vệ booking sẽ yêu cầu xác nhận trước khi bật."
              : "Each agent shows its operating impact. Customer messaging and booking-protection agents require confirmation before activation."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href={`/dashboard/${slug}/setup/manager-briefing`}
            className="rounded-full border border-nq-border/30 px-3 py-1 text-xs text-nq-muted transition-colors hover:border-nq-primary/40 hover:text-nq-primary"
          >
            {vi ? "Cấu hình →" : "Configure →"}
          </Link>
          <Link
            href={`/dashboard/${slug}/manager`}
            className="rounded-full border border-nq-border/30 px-3 py-1 text-xs text-nq-muted transition-colors hover:border-nq-primary/40 hover:text-nq-primary"
          >
            {vi ? "Nhật ký →" : "Activity →"}
          </Link>
        </div>
      </div>

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

      <NotificationSettingsField
        slug={slug}
        initialChannel={initialNotifChannel}
        initialPhone={initialOwnerPhone}
        vi={vi}
      />

      <InstructionsField
        slug={slug}
        initialValue={initialInstructions ?? ""}
        vi={vi}
      />
    </section>
  );
}
