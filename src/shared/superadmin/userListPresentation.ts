import type { SuperAdminUserRow } from "./superadminTypes";

function formatRelative(iso: string | null, observedAt: number): string {
  if (!iso) return "Never";
  const diff = observedAt - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-CA");
}

function liveStatus(lastSignInAt: string | null, observedAt: number): "live" | "today" | "week" | "dormant" {
  if (!lastSignInAt) return "dormant";
  const diff = observedAt - new Date(lastSignInAt).getTime();
  if (diff < 15 * 60 * 1000) return "live";
  if (diff < 24 * 60 * 60 * 1000) return "today";
  if (diff < 7 * 24 * 60 * 60 * 1000) return "week";
  return "dormant";
}

export type UserListRow = SuperAdminUserRow & {
  activityStatus: ReturnType<typeof liveStatus>;
  activityLabel: string;
  joinedLabel: string;
};

/** Serialize time labels with the server snapshot, shared with the summary cards.
 * Browser clock, timezone, and ICU differences must not change the first render.
 * Sorting/filtering keeps that snapshot; the next server read refreshes it.
 */
export function presentUserList(users: SuperAdminUserRow[], observedAt: number): UserListRow[] {
  return users.map(user => ({
    ...user,
    activityStatus: liveStatus(user.lastSignInAt, observedAt),
    activityLabel: formatRelative(user.lastSignInAt, observedAt),
    joinedLabel: user.createdAt
      ? new Date(user.createdAt).toLocaleDateString("en-CA")
      : "—",
  }));
}
