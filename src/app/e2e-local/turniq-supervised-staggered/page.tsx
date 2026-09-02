import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { isDemoSlugPinBypassed } from "@/shared/lib/demoOtpMode";

import {
  TurnIqSupervisedStaggeredHarness,
  type TurnIqM4iScenario,
} from "./TurnIqSupervisedStaggeredHarness";

export const dynamic = "force-dynamic";

const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

const SCENARIOS = new Set<TurnIqM4iScenario>([
  "happy",
  "stale",
  "refresh_failure",
  "offline",
]);

export default async function TurnIqSupervisedStaggeredE2ePage({
  searchParams,
}: {
  searchParams: Promise<{ scenario?: string }>;
}) {
  const host = (await headers()).get("host")?.trim() ?? "";
  if (
    !isDemoSlugPinBypassed() ||
    !LOOPBACK_HOST_RE.test(host)
  ) {
    notFound();
  }
  const requested = (await searchParams).scenario;
  const scenario = SCENARIOS.has(requested as TurnIqM4iScenario)
    ? (requested as TurnIqM4iScenario)
    : "happy";
  return <TurnIqSupervisedStaggeredHarness scenario={scenario} />;
}
