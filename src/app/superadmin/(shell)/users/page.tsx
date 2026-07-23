export const dynamic = "force-dynamic";

import { loadAllUsers } from "@/shared/superadmin/superadminActions";
import { UserListTable } from "@/components/superadmin/UserListTable";

export default async function SuperadminUsersPage() {
  const result = await loadAllUsers();

  if (!result.ok) {
    return (
      <div className="px-5 py-8 md:px-8">
        <p className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error">
          {result.error === "unauthorized"
            ? "You don't have permission to view this page."
            : "Failed to load users. Please try again."}
        </p>
      </div>
    );
  }

  const { users } = result;
  const now = new Date().getTime();
  const liveCount = users.filter((u) => {
    if (!u.lastSignInAt) return false;
    return now - new Date(u.lastSignInAt).getTime() < 15 * 60 * 1000;
  }).length;
  const todayCount = users.filter((u) => {
    if (!u.lastSignInAt) return false;
    return now - new Date(u.lastSignInAt).getTime() < 24 * 60 * 60 * 1000;
  }).length;
  const weekCount = users.filter((u) => {
    if (!u.createdAt) return false;
    return now - new Date(u.createdAt).getTime() < 7 * 24 * 60 * 60 * 1000;
  }).length;

  return (
    <div className="px-5 py-8 md:px-8">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-nq-foreground">Users</h1>
        <p className="mt-1 text-sm text-nq-muted">
          All NailIQ accounts — owners, admins, staff with dashboard access.
        </p>
      </div>

      {/* Stats bar */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total users" value={users.length} />
        <StatCard label="Live now" value={liveCount} accent="green" />
        <StatCard label="Active today" value={todayCount} accent="yellow" />
        <StatCard label="New this week" value={weekCount} accent="blue" />
      </div>

      <UserListTable users={users} />
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: "green" | "yellow" | "blue";
}) {
  const dotColor =
    accent === "green"
      ? "bg-emerald-400"
      : accent === "yellow"
        ? "bg-amber-400"
        : accent === "blue"
          ? "bg-sky-400"
          : undefined;

  return (
    <div className="rounded-xl border border-nq-border bg-nq-surface px-4 py-3">
      <div className="flex items-center gap-1.5">
        {dotColor && (
          <span className={`h-2 w-2 shrink-0 rounded-full ${dotColor}`} />
        )}
        <span className="text-xs text-nq-muted">{label}</span>
      </div>
      <p className="mt-1 text-2xl font-bold tabular-nums text-nq-foreground">
        {value}
      </p>
    </div>
  );
}
