import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { hasFeature } from "@/lib/feature-gating";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import type { Database } from "@/lib/database.types";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };
type SalonRow = Database["public"]["Tables"]["salons"]["Row"];
type ReferralRow = Database["public"]["Tables"]["referrals"]["Row"];

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Referrals · ${slug}`,
    robots: "noindex",
  };
}

type ReferralStats = {
  total: number;
  used: number;
  completed: number;
  revenueFromReferrals: number;
};

function computeStats(referrals: ReferralRow[]): ReferralStats {
  const total = referrals.length;
  const used = referrals.filter((r) => r.status === "used" || r.status === "completed").length;
  const completed = referrals.filter((r) => r.status === "completed").length;
  // Revenue is proxied as count of completed × estimated average; actual revenue requires
  // joining to bookings — surfaced here as completed referral count only.
  return { total, used, completed, revenueFromReferrals: 0 };
}

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  used: "Used",
  completed: "Completed",
  revoked: "Revoked",
  expired: "Expired",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "text-nq-warning bg-nq-warning/10",
  used: "text-nq-info bg-nq-info/10",
  completed: "text-nq-success bg-nq-success/10",
  revoked: "text-nq-error bg-nq-error/10",
  expired: "text-nq-muted bg-nq-muted/10",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function maskPhone(phone: string): string {
  if (phone.length < 4) return phone;
  return "•••" + phone.slice(-4);
}

/**
 * Owner-only referrals dashboard page.
 * Shows stats + table of all referral codes for this salon.
 * Feature-gated to bring_a_friend (premium+).
 */
export default async function ReferralsPage({ params }: PageProps) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");
  if (!isOwnerOrAdmin(ctx.role)) redirect(`/dashboard/${encodeURIComponent(slug)}`);

  // Check plan gate
  const { data: planRow } = await ctx.supabase
    .from("salons")
    .select("subscription_plan, plan_override, feature_flags")
    .eq("id", ctx.salon.id)
    .maybeSingle();

  const salonFields = (planRow ?? {}) as Pick<
    SalonRow,
    "subscription_plan" | "plan_override" | "feature_flags"
  >;

  if (!hasFeature(salonFields, "bring_a_friend")) {
    return (
      <main className="mx-auto w-full max-w-3xl px-5 py-8 md:px-8">
        <header className="flex flex-col gap-2 pb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
            Bring a Friend
          </h1>
        </header>
        <div className="flex flex-col gap-3 rounded-xl border border-nq-primary/30 bg-nq-primary/10 px-4 py-4">
          <p className="text-sm font-semibold text-nq-foreground">
            Referral Program — Studio+ Plan
          </p>
          <p className="text-sm text-nq-muted">
            Let customers earn rewards by bringing their friends. Automatic
            vouchers for both referrer and referee once the friend visits.
            Included in Studio/Premium and above.
          </p>
          <div>
            <a
              href={`/dashboard/${encodeURIComponent(slug)}/settings/billing`}
              className="inline-flex items-center rounded-full bg-nq-primary px-4 py-2 text-sm font-medium text-nq-bg hover:bg-nq-primary-soft"
            >
              Upgrade plan →
            </a>
          </div>
        </div>
      </main>
    );
  }

  // Fetch all referrals for this salon
  const { data: referrals } = await ctx.supabase
    .from("referrals")
    .select(
      "id, code, referrer_phone, referee_phone, status, referrer_reward_percent_off, referee_reward_percent_off, created_at, used_at, completed_at, expires_at",
    )
    .eq("salon_id", ctx.salon.id)
    .order("created_at", { ascending: false });

  const rows = (referrals ?? []) as ReferralRow[];
  const stats = computeStats(rows);

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8 md:px-8">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
          Bring a Friend
        </h1>
        <p className="mt-1 text-sm text-nq-muted">
          Track referral activity and manage codes issued by your customers.
        </p>
      </header>

      {/* Stats row */}
      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total Invites" value={stats.total} />
        <StatCard label="Used" value={stats.used} />
        <StatCard label="Completed" value={stats.completed} />
        <StatCard
          label="Conversion"
          value={
            stats.used > 0 ? `${Math.round((stats.completed / stats.used) * 100)}%` : "—"
          }
        />
      </div>

      {/* Referrals table */}
      {rows.length === 0 ? (
        <div className="rounded-2xl border border-nq-border bg-nq-surface p-8 text-center">
          <p className="text-sm text-nq-muted">
            No referral codes yet. They&apos;re created automatically when customers share their
            booking link.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-nq-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-nq-border bg-nq-surface/60">
                <th className="px-4 py-3 text-left font-medium text-nq-muted">Code</th>
                <th className="px-4 py-3 text-left font-medium text-nq-muted">Referrer</th>
                <th className="px-4 py-3 text-left font-medium text-nq-muted">Referee</th>
                <th className="px-4 py-3 text-left font-medium text-nq-muted">Status</th>
                <th className="px-4 py-3 text-left font-medium text-nq-muted">Reward</th>
                <th className="px-4 py-3 text-left font-medium text-nq-muted">Date</th>
                <th className="px-4 py-3 text-left font-medium text-nq-muted">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-nq-border bg-nq-surface">
              {rows.map((ref) => (
                <tr key={ref.id} className="hover:bg-nq-surface/80 transition-colors">
                  <td className="px-4 py-3">
                    <span className="font-mono font-semibold text-nq-primary">
                      {ref.code}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-nq-foreground">
                    {maskPhone(ref.referrer_phone)}
                  </td>
                  <td className="px-4 py-3 text-nq-muted">
                    {ref.referee_phone ? maskPhone(ref.referee_phone) : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[ref.status] ?? "text-nq-muted bg-nq-surface"}`}
                    >
                      {STATUS_LABELS[ref.status] ?? ref.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-nq-muted">
                    {ref.referrer_reward_percent_off ?? 10}% / {ref.referee_reward_percent_off ?? 10}%
                  </td>
                  <td className="px-4 py-3 text-nq-muted">
                    {ref.completed_at
                      ? formatDate(ref.completed_at)
                      : ref.used_at
                        ? formatDate(ref.used_at)
                        : formatDate(ref.created_at)}
                  </td>
                  <td className="px-4 py-3">
                    {ref.status !== "revoked" && ref.status !== "completed" ? (
                      <RevokeButton referralId={ref.id} slug={slug} />
                    ) : (
                      <span className="text-xs text-nq-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-nq-border bg-nq-surface p-4">
      <p className="text-xs font-medium text-nq-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-nq-foreground">
        {value}
      </p>
    </div>
  );
}

/**
 * Revoke button — client-side via a form POST to avoid needing a
 * separate client component file. Uses a plain HTML form with a
 * hidden method override so it works without JS too.
 */
function RevokeButton({ referralId, slug }: { referralId: string; slug: string }) {
  return (
    <form
      action={`/api/referrals/${referralId}/revoke`}
      method="POST"
      onSubmit={(e) => {
        // Progressive enhancement: intercept with fetch for instant UI update
        e.preventDefault();
        void fetch(`/api/referrals/${referralId}/revoke`, { method: "PATCH" }).then(() => {
          window.location.reload();
        });
      }}
    >
      <input type="hidden" name="_method" value="PATCH" />
      <button
        type="submit"
        className="text-xs text-nq-error underline-offset-2 hover:underline"
      >
        Revoke
      </button>
    </form>
  );
}
