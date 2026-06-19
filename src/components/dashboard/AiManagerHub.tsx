"use client";

import Link from "next/link";
import { useState, useTransition, useRef, useCallback } from "react";
import { updateAiAgentFlag, updateAiManagerInstructions, updateOwnerNotificationSettings } from "@/shared/dashboard/salonOwnerActions";
import type { AiAgentFlagKey, AiAgentFlags } from "@/shared/dashboard/aiAgentTypes";
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
      "Gộp tất cả email riêng lẻ từ các agent thành 1 bản tổng kết duy nhất lúc 21:00, viết bằng giọng Minh: hôm nay thế nào, AI đã làm gì, ngày mai cần chú ý gì.",
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
              ? "Bật/tắt từng agent AI. Mỗi agent tự điều tiết — bật an toàn mà không lo spam."
              : "Toggle each AI agent on or off. Every agent self-throttles — safe to enable without risk of over-messaging."}
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
