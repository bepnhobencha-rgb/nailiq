"use client";

import { useImmediateSettingSave } from "@/components/dashboard/useImmediateSettingSave";
import { Button } from "@/components/ui/Button";
import {
  updateGroupTogetherThreshold,
  updateGroupWaveStrategy,
} from "@/shared/dashboard/salonOwnerActions";
import type { GroupWaveStrategy } from "@/shared/booking/groupWaveOptimizer";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Props = {
  slug: string;
  initialMinutes: number;
  initialStrategy: GroupWaveStrategy;
};

// How far apart group members can start and still feel "together".
const PRESETS = [15, 30, 45, 60, 90] as const;

const STRATEGIES: readonly GroupWaveStrategy[] = [
  "maximize_revenue",
  "balanced",
  "on_time",
];

/**
 * Owner/admin settings for group togetherness and later-wave timing. When a group
 * can't all fit one time, members starting within this spread are offered as
 * "still together" first; beyond it the flow suggests an all-together time.
 */
export function GroupTogetherSettings({
  slug,
  initialMinutes,
  initialStrategy,
}: Props) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const {
    value: minutes,
    status,
    isSaving,
    change,
  } = useImmediateSettingSave({
    initialValue: initialMinutes,
    save: async (next) => {
      const res = await updateGroupTogetherThreshold(slug, next);
      return res.ok
        ? { ok: true, value: res.minutes }
        : { ok: false };
    },
  });
  const {
    value: strategy,
    status: strategyStatus,
    isSaving: isStrategySaving,
    change: changeStrategy,
  } = useImmediateSettingSave({
    initialValue: initialStrategy,
    save: async (next) => {
      const res = await updateGroupWaveStrategy(slug, next);
      return res.ok
        ? { ok: true, value: res.strategy }
        : { ok: false };
    },
  });

  const label = (m: number) =>
    m >= 60
      ? vi
        ? `${m / 60} giờ`
        : `${m / 60}h`
      : `${m} ${vi ? "phút" : "min"}`;

  const strategyLabel = (value: GroupWaveStrategy) => {
    if (value === "balanced") return vi ? "Cân bằng" : "Balanced";
    if (value === "on_time") return vi ? "Ưu tiên đúng giờ" : "On-time first";
    return vi ? "Tối đa công suất" : "Maximize capacity";
  };

  const strategyDescription =
    strategy === "balanced"
      ? vi
        ? "Xếp đợt sau theo mốc 5 phút để dễ vận hành nhưng vẫn giữ lịch gọn."
        : "Align later waves to 5-minute marks for a calm desk and compact schedule."
      : strategy === "on_time"
        ? vi
          ? "Xếp đợt sau theo mốc 15 phút, dễ nhớ và dễ thông báo nhất cho khách."
          : "Align later waves to 15-minute marks for the clearest customer promise."
        : vi
          ? "Bắt đầu đợt sau ngay khi thợ và tài nguyên an toàn; ví dụ 10:10 thay vì chờ 10:15."
          : "Start the next wave as soon as staff and resources are safely ready; for example 10:10 instead of waiting for 10:15.";

  return (
    <section
      data-testid="settings-group-together"
      className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
    >
      <p className="text-sm font-semibold text-nq-foreground">
        {vi ? "Nhóm — độ lệch vẫn coi là “cùng nhau”" : "Group — “together” window"}
      </p>
      <p className="mt-0.5 text-xs text-nq-muted">
        {vi
          ? "Khi cả nhóm không xếp được cùng một giờ, vài người lệch trong khoảng này vẫn được xem là cùng nhau (theo đợt). Lệch hơn thì gợi ý giờ cả nhóm cùng lúc."
          : "When a group can't all fit one time, members starting within this window still count as together (gentle waves). Beyond it, the flow suggests an all-together time."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {PRESETS.map((m) => {
          const on = minutes === m;
          return (
            <Button
              key={m}
              variant={on ? "primary" : "secondary"}
              size="md"
              aria-pressed={on}
              disabled={isSaving}
              onClick={() => change(m)}
            >
              {label(m)}
            </Button>
          );
        })}
      </div>
      <p
        data-testid="settings-group-together-save-status"
        className={`mt-3 min-h-5 text-sm ${
          status === "error"
            ? "text-nq-error"
            : status === "saved"
              ? "text-nq-success"
              : "text-nq-muted"
        }`}
        role="status"
        aria-live="polite"
      >
        {status === "saving"
          ? vi
            ? "Đang lưu…"
            : "Saving…"
          : status === "saved"
            ? vi
              ? "✓ Đã lưu"
              : "✓ Saved"
            : status === "error"
              ? vi
                ? "Không thể lưu. Chọn lại để thử lại."
                : "Could not save. Select again to retry."
              : vi
                ? "Tự động lưu khi bạn chọn."
                : "Saves automatically when selected."}
      </p>

      <div className="mt-5 border-t border-nq-border/30 pt-4">
        <p className="text-sm font-semibold text-nq-foreground">
          {vi ? "Chiến lược xếp đợt" : "Wave timing strategy"}
        </p>
        <p className="mt-0.5 text-xs text-nq-muted">
          {vi
            ? "Áp dụng cùng một quy tắc cho booking nhóm trên web và Voice AI. Không thay đổi lịch đã xác nhận."
            : "Uses the same rule for web and Voice AI group bookings. Confirmed bookings never move."}
        </p>
        <div
          className="mt-3 flex flex-wrap gap-2"
          role="group"
          aria-label={vi ? "Chiến lược xếp đợt" : "Wave timing strategy"}
        >
          {STRATEGIES.map((value) => (
            <Button
              key={value}
              variant={strategy === value ? "primary" : "secondary"}
              size="md"
              aria-pressed={strategy === value}
              disabled={isStrategySaving}
              onClick={() => changeStrategy(value)}
            >
              {strategyLabel(value)}
            </Button>
          ))}
        </div>
        <p className="mt-3 text-sm text-nq-muted">{strategyDescription}</p>
        <p
          data-testid="settings-group-wave-strategy-save-status"
          className={`mt-2 min-h-5 text-sm ${
            strategyStatus === "error"
              ? "text-nq-error"
              : strategyStatus === "saved"
                ? "text-nq-success"
                : "text-nq-muted"
          }`}
          role="status"
          aria-live="polite"
        >
          {strategyStatus === "saving"
            ? vi
              ? "Đang lưu…"
              : "Saving…"
            : strategyStatus === "saved"
              ? vi
                ? "✓ Đã lưu cho booking nhóm mới"
                : "✓ Saved for new group bookings"
              : strategyStatus === "error"
                ? vi
                  ? "Không thể lưu. Chọn lại để thử lại."
                  : "Could not save. Select again to retry."
                : vi
                  ? "Tự động lưu khi bạn chọn."
                  : "Saves automatically when selected."}
        </p>
      </div>
    </section>
  );
}
