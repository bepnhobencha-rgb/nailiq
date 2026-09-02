import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { isDemoSlugPinBypassed } from "@/shared/lib/demoOtpMode";

import {
  TurnIqCustomerCheckInHarness,
  type TurnIqM4lScenario,
} from "./TurnIqCustomerCheckInHarness";

export const dynamic = "force-dynamic";

const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;
const SCENARIOS = new Set<TurnIqM4lScenario>([
  "booked",
  "group",
  "requested",
  "walkin",
  "offline",
  "server",
]);

export default async function TurnIqCustomerCheckInE2ePage({
  searchParams,
}: {
  searchParams: Promise<{ scenario?: string }>;
}) {
  const host = (await headers()).get("host")?.trim() ?? "";
  if (!isDemoSlugPinBypassed() || !LOOPBACK_HOST_RE.test(host)) notFound();
  const requested = (await searchParams).scenario;
  const scenario = SCENARIOS.has(requested as TurnIqM4lScenario)
    ? requested as TurnIqM4lScenario
    : "booked";
  return <TurnIqCustomerCheckInHarness scenario={scenario} />;
}
