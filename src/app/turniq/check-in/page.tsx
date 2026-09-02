import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { isReleaseFeatureVisible } from "@/shared/features/platformFeatureFlags";
import { resolvePublicBookingPage } from "@/shared/booking/resolvePublicBookingPage";
import { loadTurnIqRolloutStage } from "@/shared/turniq/serverDal";
import { turnIqStageAllowsOnlineMutation } from "@/shared/turniq/rolloutStage";

import { TurnIqPublicCheckInClient } from "./TurnIqPublicCheckInClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Customer check-in · NailIQ",
  robots: "noindex, nofollow",
  referrer: "no-referrer",
};

function previewRuntime(): boolean {
  if (process.env.NODE_ENV === "test") return true;
  if (process.env.VERCEL_ENV === "preview") return true;
  return process.env.NAILIQ_TURNIQ_CHECKIN_LOCAL === "1"
    && process.env.NODE_ENV !== "production";
}

export default async function TurnIqCustomerCheckInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!previewRuntime()) notFound();
  const query = await searchParams;
  const salon = typeof query.salon === "string" ? query.salon : "";
  const channel = query.channel === "qr" || query.channel === "kiosk"
    ? query.channel
    : null;
  const visitKind = query.visit === "booked" || query.visit === "walkin"
    ? query.visit
    : null;
  const serviceId = typeof query.service === "string" ? query.service : null;
  const partySize = Number(typeof query.party === "string" ? query.party : "1");
  if (
    !channel
    || !visitKind
    || (channel === "qr") !== (visitKind === "booked")
    || !Number.isInteger(partySize)
    || partySize < 1
    || partySize > 12
  ) notFound();

  const resolved = await resolvePublicBookingPage(salon);
  if (resolved.status !== "ok") notFound();
  if (!(await isReleaseFeatureVisible({
    feature_flags: {
      turniq_trust_engine_enabled: resolved.load.salon.turnIqEnabled,
    },
  }, "turniq_trust_engine"))) {
    notFound();
  }
  if (!turnIqStageAllowsOnlineMutation(
    await loadTurnIqRolloutStage(resolved.load.salon.id),
  )) notFound();
  const services = resolved.load.services
    .filter((service) => visitKind === "walkin" || service.id === serviceId)
    .map((service) => ({ id: service.id, name: service.name }));
  if (services.length === 0) notFound();
  const technicians = resolved.load.staff.map((staff) => ({
    id: staff.id,
    name: staff.name,
  }));
  return (
    <main className="flex min-h-dvh items-center justify-center bg-nq-bg px-4 py-8">
      <TurnIqPublicCheckInClient
        salonName={resolved.load.salon.name}
        channel={channel}
        visitKind={visitKind}
        services={services}
        technicians={technicians}
        partySize={partySize}
      />
    </main>
  );
}
