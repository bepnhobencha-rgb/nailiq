import { cn } from "@/shared/lib/cn";
import { Badge } from "@/components/ui/Badge";

export type StaffStatus = "available" | "busy" | "overbooked" | "offline";
export type StaffSize = "sm" | "md" | "lg";
export type StaffSkill = "acrylic" | "design" | "pedicure" | "fast" | "junior";

const avatarSizeClasses: Record<StaffSize, string> = {
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-14 w-14 text-base",
};

const dotSizeClasses: Record<StaffSize, string> = {
  sm: "h-2 w-2",
  md: "h-2.5 w-2.5",
  lg: "h-3 w-3",
};

const statusColors: Record<StaffStatus, string> = {
  available: "bg-nq-success",
  busy: "bg-nq-warning",
  overbooked: "bg-nq-error",
  offline: "bg-nq-muted",
};

const statusLabels: Record<StaffStatus, string> = {
  available: "Available",
  busy: "Busy",
  overbooked: "Overbooked",
  offline: "Offline",
};

const workloadFillColors: Record<StaffStatus, string> = {
  available: "bg-nq-success",
  busy: "bg-nq-warning",
  overbooked: "bg-nq-error",
  offline: "bg-nq-muted",
};

function getInitials(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  const first = parts[0]?.[0] ?? "";
  const last = parts[parts.length - 1]?.[0] ?? "";
  return (first + last).toUpperCase();
}

export type StaffAvatarProps = {
  name: string;
  imageUrl?: string;
  status: StaffStatus;
  workload?: number;
  showWorkload?: boolean;
  showStatus?: boolean;
  size: StaffSize;
  skills?: ReadonlyArray<StaffSkill>;
  showSkills?: boolean;
  className?: string;
};

export function StaffAvatar({
  name,
  imageUrl,
  status,
  workload,
  showWorkload = false,
  showStatus = true,
  size,
  skills,
  showSkills = false,
  className,
}: StaffAvatarProps) {
  const initials = getInitials(name);
  const safeWorkload =
    typeof workload === "number"
      ? Math.max(0, Math.min(100, workload))
      : 0;
  const showWorkloadBar = showWorkload && typeof workload === "number";
  const showSkillsRow = showSkills && skills !== undefined && skills.length > 0;

  return (
    <div
      className={cn(
        "inline-flex flex-col items-center gap-1",
        className,
      )}
    >
      <div className="relative inline-flex">
        <div
          role="img"
          aria-label={name}
          className={cn(
            "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full",
            "select-none border border-nq-border bg-nq-surface font-semibold text-nq-foreground",
            avatarSizeClasses[size],
          )}
        >
          {imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt={name}
              className="h-full w-full object-cover"
              draggable={false}
              loading="lazy"
            />
          ) : (
            <span aria-hidden>{initials}</span>
          )}
        </div>
        {showStatus ? (
          <span
            role="status"
            aria-label={statusLabels[status]}
            className={cn(
              "absolute bottom-0 right-0 inline-block rounded-full ring-2 ring-nq-bg",
              dotSizeClasses[size],
              statusColors[status],
            )}
          />
        ) : null}
      </div>

      {showWorkloadBar ? (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={safeWorkload}
          aria-label={`${name} workload ${safeWorkload}%`}
          className="h-1 w-full overflow-hidden rounded-full bg-nq-border/60"
        >
          <div
            className={cn("h-full", workloadFillColors[status])}
            style={{ width: `${safeWorkload}%` }}
            aria-hidden
          />
        </div>
      ) : null}

      {showSkillsRow ? (
        <div className="flex flex-wrap items-center justify-center gap-1">
          {skills.map((skill) => (
            <Badge key={skill} size="sm" state="subtle" variant="neutral">
              {skill}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default StaffAvatar;
