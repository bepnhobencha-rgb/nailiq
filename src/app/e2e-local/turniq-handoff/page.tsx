import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { isDemoSlugPinBypassed } from "@/shared/lib/demoOtpMode";

import { TurnIqHandoffHarness } from "./TurnIqHandoffHarness";

export const dynamic = "force-dynamic";

const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

export default async function TurnIqHandoffE2ePage() {
  const host = (await headers()).get("host")?.trim() ?? "";
  if (!isDemoSlugPinBypassed() || !LOOPBACK_HOST_RE.test(host)) notFound();
  return <TurnIqHandoffHarness />;
}
