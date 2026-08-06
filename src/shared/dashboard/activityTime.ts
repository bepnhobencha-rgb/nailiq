export function activityTimeAgo(
  iso: string,
  nowMs: number,
  timeZone: string,
): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) return "";

  const diff = Math.max(0, nowMs - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "vừa xong";
  if (minutes < 60) return `${minutes} phút trước`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} ngày trước`;

  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone,
  }).format(new Date(ms));
}
