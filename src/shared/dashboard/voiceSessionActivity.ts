import { SESSION_TTL_SECONDS } from "@/shared/voiceai/config";

export type VoiceSessionDisplayStatus =
  | "active"
  | "completed"
  | "failed"
  | "abandoned"
  | "interrupted";

const KNOWN_STATUSES = new Set<VoiceSessionDisplayStatus>([
  "active",
  "completed",
  "failed",
  "abandoned",
  "interrupted",
]);

/**
 * Derive an honest owner-facing state without rewriting historical call rows.
 * A realtime session cannot live beyond SESSION_TTL_SECONDS, so an `active`
 * row older than that lifetime is an interrupted finalization, not a call that
 * is still running.
 */
export function voiceSessionDisplayStatus(
  rawStatus: unknown,
  startedAt: unknown,
  endedAt: unknown,
  nowMs: number,
): VoiceSessionDisplayStatus {
  const status =
    typeof rawStatus === "string" &&
    KNOWN_STATUSES.has(rawStatus as VoiceSessionDisplayStatus)
      ? (rawStatus as VoiceSessionDisplayStatus)
      : "failed";

  if (status !== "active" || endedAt) return status;

  const startedAtMs =
    typeof startedAt === "string" ? Date.parse(startedAt) : Number.NaN;
  if (
    Number.isFinite(nowMs) &&
    Number.isFinite(startedAtMs) &&
    nowMs - startedAtMs > SESSION_TTL_SECONDS * 1000
  ) {
    return "interrupted";
  }

  return status;
}

export function voiceSessionStatusLabel(
  status: VoiceSessionDisplayStatus,
): string {
  switch (status) {
    case "active":
      return "Đang gọi";
    case "completed":
      return "Hoàn tất";
    case "failed":
      return "Lỗi";
    case "abandoned":
      return "Đã kết thúc";
    case "interrupted":
      return "Gián đoạn";
  }
}
