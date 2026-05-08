import { Badge, type BadgeSize, type BadgeVariant } from "@/components/ui/Badge";

export type QueueSourceVariant =
  | "online"
  | "walk-in"
  | "instagram"
  | "google"
  | "phone"
  | "tiktok"
  | "repeat"
  | "vip";

export type QueuePriorityVariant = "high" | "medium" | "low";

export type QueueChipType = "source" | "priority" | "request";
export type QueueChipSize = "sm" | "md";

const sourceVariantMap: Record<QueueSourceVariant, BadgeVariant> = {
  online: "info",
  "walk-in": "neutral",
  instagram: "info",
  google: "info",
  phone: "neutral",
  tiktok: "info",
  repeat: "success",
  vip: "vip",
};

const priorityVariantMap: Record<QueuePriorityVariant, BadgeVariant> = {
  high: "danger",
  medium: "warning",
  low: "neutral",
};

export type QueueChipProps =
  | {
      type: "source";
      label: string;
      variant: QueueSourceVariant;
      size?: QueueChipSize;
      className?: string;
      "aria-label"?: string;
    }
  | {
      type: "priority";
      label: string;
      variant: QueuePriorityVariant;
      size?: QueueChipSize;
      className?: string;
      "aria-label"?: string;
    }
  | {
      type: "request";
      label: string;
      variant?: never;
      size?: QueueChipSize;
      className?: string;
      "aria-label"?: string;
    };

function resolveBadgeVariant(props: QueueChipProps): BadgeVariant {
  if (props.type === "source") return sourceVariantMap[props.variant];
  if (props.type === "priority") return priorityVariantMap[props.variant];
  return "neutral";
}

export function QueueChip(props: QueueChipProps) {
  const size: BadgeSize = props.size ?? "sm";
  const variant = resolveBadgeVariant(props);

  return (
    <Badge
      variant={variant}
      size={size}
      state="subtle"
      className={props.className}
      aria-label={props["aria-label"]}
    >
      {props.label}
    </Badge>
  );
}

export default QueueChip;
