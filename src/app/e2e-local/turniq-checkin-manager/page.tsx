import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { isDemoSlugPinBypassed } from "@/shared/lib/demoOtpMode";

import { TurnIqCheckInManagerHarness } from "./TurnIqCheckInManagerHarness";

export const dynamic = "force-dynamic";

const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

export default async function TurnIqCheckInManagerE2ePage({
  searchParams,
}: {
  searchParams: Promise<{ expiry?: string }>;
}) {
  const host = (await headers()).get("host")?.trim() ?? "";
  if (!isDemoSlugPinBypassed() || !LOOPBACK_HOST_RE.test(host)) notFound();
  const shortExpiry = (await searchParams).expiry === "short";
  return <TurnIqCheckInManagerHarness shortExpiry={shortExpiry} />;
}
