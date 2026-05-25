"use client";

import { cn } from "@/shared/lib/cn";

type StampCardProps = {
  current: number;
  required: number;
  color?: string;
  programName?: string;
  rewardLabel?: string;
  compact?: boolean;
};

export function StampCard({
  current,
  required,
  color = "#D4AF37",
  programName = "Loyalty Rewards",
  rewardLabel,
  compact = false,
}: StampCardProps) {
  const filled = Math.min(current, required);
  const stamps = Array.from({ length: required }, (_, i) => i < filled);

  return (
    <div
      className={cn(
        "rounded-2xl border p-4",
        compact ? "p-3" : "p-5",
      )}
      style={{
        borderColor: `${color}40`,
        background: `linear-gradient(135deg, ${color}08, ${color}04)`,
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <span className={cn("font-semibold text-white", compact ? "text-xs" : "text-sm")}>
          {programName}
        </span>
        <span className={cn("font-medium", compact ? "text-[10px]" : "text-xs")} style={{ color }}>
          {filled}/{required} stamps
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {stamps.map((isFilled, i) => (
          <div
            key={i}
            className={cn(
              "rounded-full border transition-all",
              compact ? "h-5 w-5" : "h-6 w-6",
              isFilled ? "shadow-sm" : "opacity-30",
            )}
            style={{
              backgroundColor: isFilled ? color : "transparent",
              borderColor: color,
            }}
          >
            {isFilled && (
              <svg viewBox="0 0 24 24" fill="none" className="w-full h-full p-0.5">
                <polyline
                  points="20 6 9 17 4 12"
                  stroke={current === required && i === required - 1 ? "#fff" : "#000"}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </div>
        ))}
      </div>

      {rewardLabel && (
        <p className={cn("mt-2 text-[#a1a1aa]", compact ? "text-[10px]" : "text-xs")}>
          {current >= required
            ? "🎉 Reward earned! Use code at next visit."
            : `${required - filled} more ${required - filled === 1 ? "visit" : "visits"} = ${rewardLabel}`}
        </p>
      )}
    </div>
  );
}
