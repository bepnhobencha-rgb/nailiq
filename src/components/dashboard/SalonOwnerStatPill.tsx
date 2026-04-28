import { cn } from "@/shared/lib/cn";

export function SalonOwnerStatPill({
  label,
  value,
  accent,
  className,
}: {
  label: string;
  value: string;
  accent?: "gold" | "blue" | "green";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-nq-border/35 bg-nq-surface/40 px-3 py-3",
        accent === "gold" && "ring-1 ring-nq-primary/20",
        accent === "blue" && "ring-1 ring-nq-info/20",
        accent === "green" && "ring-1 ring-nq-success/20",
        className,
      )}
    >
      <p className="text-[11px] font-medium text-nq-muted">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-xl font-semibold tabular-nums",
          !accent && "text-nq-foreground",
          accent === "gold" && "text-nq-primary",
          accent === "blue" && "text-nq-info",
          accent === "green" && "text-nq-success",
        )}
      >
        {value}
      </p>
    </div>
  );
}
