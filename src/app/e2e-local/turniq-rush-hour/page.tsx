import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { isTurnIqRushHourDemoAllowed } from "@/shared/turniq/rushHourDemoBoundary";
import { TurnIqRushHourHarness } from "./TurnIqRushHourHarness";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Synthetic TurnIQ rush-hour demo",
  robots: "noindex, nofollow",
  referrer: "no-referrer",
};

export default async function TurnIqRushHourPage() {
  const host = (await headers()).get("host")?.trim() ?? "";
  if (!isTurnIqRushHourDemoAllowed(host)) notFound();
  return <TurnIqRushHourHarness />;
}
