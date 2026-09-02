import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isReleaseFeatureVisible } from "@/shared/features/platformFeatureFlags";
import { isFrontDeskRole } from "@/shared/lib/salonMemberRole";

import { TurnIqCheckInLinkManager } from "./TurnIqCheckInLinkManager";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "TurnIQ customer check-in", robots: "noindex" };

function previewRuntime(): boolean {
  if (process.env.NODE_ENV === "test") return true;
  if (process.env.VERCEL_ENV === "preview") return true;
  return process.env.NAILIQ_TURNIQ_CHECKIN_LOCAL === "1"
    && process.env.NODE_ENV !== "production";
}

function startLabel(value: unknown, timezone: string): string {
  const date = new Date(String(value ?? ""));
  if (!Number.isFinite(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export default async function TurnIqCheckInManagerPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!previewRuntime()) notFound();
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");
  if (ctx.kind !== "member" || !isFrontDeskRole(ctx.role)) notFound();
  if (!(await isReleaseFeatureVisible(ctx.salon, "turniq_trust_engine"))) notFound();

  const [{ data: bookingRows }, { data: serviceRows }] = await Promise.all([
    ctx.supabase
      .from("bookings")
      .select("id, service_id, start_time_utc, party_size")
      .eq("salon_id", ctx.salon.id)
      .is("deleted_at", null)
      .in("status", ["pending", "confirmed"])
      .order("start_time_utc", { ascending: true })
      .limit(100),
    ctx.supabase
      .from("services")
      .select("id, name")
      .eq("salon_id", ctx.salon.id)
      .is("deleted_at", null),
  ]);
  const services = new Map(
    (serviceRows ?? []).map((row) => [String(row.id), String(row.name ?? "Service")]),
  );
  const bookings = (bookingRows ?? []).flatMap((row) => {
    const id = String(row.id ?? "");
    const serviceId = String(row.service_id ?? "");
    const partySize = Number(row.party_size ?? 1);
    if (!id || !services.has(serviceId) || !Number.isInteger(partySize)) return [];
    return [{
      id,
      serviceName: services.get(serviceId)!,
      startLabel: startLabel(row.start_time_utc, ctx.salon.timezone),
      partySize,
    }];
  });
  return (
    <main className="min-h-dvh bg-nq-bg px-4 py-8 text-nq-foreground">
      <TurnIqCheckInLinkManager
        slug={slug}
        salonName={ctx.salon.name}
        bookings={bookings}
      />
    </main>
  );
}
