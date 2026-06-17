"use client";

// SipReviewCard — displays the generated Salon Intelligence Profile as
// editable fields. Owner reviews, tweaks, then confirms to activate AI Manager.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { confirmManagerBriefing } from "@/shared/ai/confirmManagerBriefingAction";
import type { SalonIntelligenceProfile } from "@/shared/ai/types";

type Props = {
  slug: string;
  initial: SalonIntelligenceProfile;
};

// ── Label maps ──────────────────────────────────────────────────────────────

const VERTICAL_LABELS: Record<SalonIntelligenceProfile["vertical"], string> = {
  nail: "Nail salon",
  head_spa: "Head spa",
  massage: "Massage",
  facial: "Facial",
  waxing: "Waxing",
  multi: "Multi-service",
};

const BRAND_VOICE_LABELS: Record<SalonIntelligenceProfile["brand_voice"], string> = {
  warm_casual: "Ấm áp & thân thiện",
  warm_professional: "Ấm áp & chuyên nghiệp",
  luxury_formal: "Sang trọng & trang trọng",
  friendly_fun: "Vui vẻ & năng động",
};

const LANG_LABELS: Record<string, string> = {
  en: "Tiếng Anh",
  vi: "Tiếng Việt",
  zh: "Tiếng Trung",
  ko: "Tiếng Hàn",
};

const NOSHOW_LABELS: Record<SalonIntelligenceProfile["noshow_strictness"], string> = {
  lenient: "Nhẹ nhàng — nhắc nhở, không phạt",
  moderate: "Vừa phải — yêu cầu lưu thẻ sau 1 lần no-show",
  strict: "Nghiêm ngặt — yêu cầu đặt cọc ngay",
};

const WINBACK_LABELS: Record<SalonIntelligenceProfile["winback_cadence"], string> = {
  gentle: "Nhẹ nhàng — 1 lần nhắc",
  normal: "Bình thường — 2-3 lần nhắc",
  aggressive: "Tích cực — nhắc nhiều lần",
};

const GOAL_LABELS: Record<SalonIntelligenceProfile["primary_goal"], string> = {
  retain_regulars: "Giữ khách quen",
  attract_new: "Kéo khách mới",
  maximize_revenue: "Tăng doanh thu",
};

// ── Select helper ────────────────────────────────────────────────────────────

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

const selectCls =
  "w-full rounded-xl border border-nq-border/40 bg-nq-surface/60 px-3 py-2 text-sm text-nq-foreground focus:border-nq-primary/40 focus:outline-none focus:ring-1 focus:ring-nq-primary/30";

const inputCls =
  "w-full rounded-xl border border-nq-border/40 bg-nq-surface/60 px-3 py-2 text-sm text-nq-foreground placeholder:text-nq-muted/60 focus:border-nq-primary/40 focus:outline-none focus:ring-1 focus:ring-nq-primary/30";

// ── Component ────────────────────────────────────────────────────────────────

export function SipReviewCard({ slug, initial }: Props) {
  const [sip, setSip] = useState<SalonIntelligenceProfile>(initial);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function update<K extends keyof SalonIntelligenceProfile>(
    key: K,
    value: SalonIntelligenceProfile[K],
  ) {
    setSip((prev) => ({ ...prev, [key]: value }));
  }

  function handleConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await confirmManagerBriefing({ slug, sip });
      if (result.ok) {
        router.push(`/dashboard/${slug}/settings`);
      } else {
        setError("Có lỗi khi lưu — vui lòng thử lại.");
      }
    });
  }

  return (
    <div className="mt-4 rounded-2xl border border-nq-primary/25 bg-nq-primary/5 px-4 py-5">
      <p className="mb-1 text-sm font-semibold text-nq-primary">
        AI Manager đã hiểu tiệm của bạn
      </p>
      <p className="mb-4 text-xs text-nq-muted">
        Xem lại và điều chỉnh nếu cần, rồi nhấn xác nhận để kích hoạt.
      </p>

      <div className="flex flex-col gap-4">
        {/* Loại tiệm */}
        <Field label="Loại dịch vụ">
          <select
            className={selectCls}
            value={sip.vertical}
            onChange={(e) =>
              update("vertical", e.target.value as SalonIntelligenceProfile["vertical"])
            }
          >
            {Object.entries(VERTICAL_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>

        {/* Giọng nói thương hiệu */}
        <Field label="Phong cách giao tiếp">
          <select
            className={selectCls}
            value={sip.brand_voice}
            onChange={(e) =>
              update("brand_voice", e.target.value as SalonIntelligenceProfile["brand_voice"])
            }
          >
            {Object.entries(BRAND_VOICE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>

        {/* Ngôn ngữ chính */}
        <Field label="Ngôn ngữ chính với khách">
          <select
            className={selectCls}
            value={sip.language_primary}
            onChange={(e) =>
              update(
                "language_primary",
                e.target.value as SalonIntelligenceProfile["language_primary"],
              )
            }
          >
            {Object.entries(LANG_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>

        {/* No-show */}
        <Field label="Mức độ xử lý no-show">
          <select
            className={selectCls}
            value={sip.noshow_strictness}
            onChange={(e) =>
              update(
                "noshow_strictness",
                e.target.value as SalonIntelligenceProfile["noshow_strictness"],
              )
            }
          >
            {Object.entries(NOSHOW_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>

        {/* Giờ liên hệ */}
        <Field label="Khung giờ liên hệ khách (HH:MM-HH:MM)">
          <input
            type="text"
            className={inputCls}
            value={sip.contact_window}
            placeholder="9:00-20:00"
            onChange={(e) => update("contact_window", e.target.value)}
          />
        </Field>

        {/* Win-back */}
        <Field label="Tần suất nhắc khách quay lại">
          <select
            className={selectCls}
            value={sip.winback_cadence}
            onChange={(e) =>
              update(
                "winback_cadence",
                e.target.value as SalonIntelligenceProfile["winback_cadence"],
              )
            }
          >
            {Object.entries(WINBACK_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>

        {/* Primary goal */}
        <Field label="Mục tiêu ưu tiên hiện tại">
          <select
            className={selectCls}
            value={sip.primary_goal}
            onChange={(e) =>
              update(
                "primary_goal",
                e.target.value as SalonIntelligenceProfile["primary_goal"],
              )
            }
          >
            {Object.entries(GOAL_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {error ? (
        <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </p>
      ) : null}

      <button
        onClick={handleConfirm}
        disabled={isPending}
        className="mt-5 w-full rounded-xl bg-nq-primary px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
      >
        {isPending ? "Đang lưu…" : "✓ Xác nhận & kích hoạt AI Manager"}
      </button>
    </div>
  );
}
