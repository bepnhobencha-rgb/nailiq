import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { isDemoSlugPinBypassed } from "@/shared/lib/demoOtpMode";

import { TurnIqStaffPinHarness } from "./TurnIqStaffPinHarness";

export const dynamic = "force-dynamic";

const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

export default async function TurnIqStaffPinE2ePage() {
  const host = (await headers()).get("host")?.trim() ?? "";
  if (!isDemoSlugPinBypassed() || !LOOPBACK_HOST_RE.test(host)) notFound();
  return <TurnIqStaffPinHarness />;
}
