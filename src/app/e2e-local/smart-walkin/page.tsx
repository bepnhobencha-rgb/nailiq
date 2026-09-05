import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { SmartWalkinHarness } from "./SmartWalkinHarness";

export const dynamic = "force-dynamic";

const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

export default async function SmartWalkinE2ePage() {
  const host = (await headers()).get("host")?.trim() ?? "";
  if (process.env.NODE_ENV !== "development" || !LOOPBACK_HOST_RE.test(host)) {
    notFound();
  }
  return <SmartWalkinHarness observedAtIso={new Date().toISOString()} />;
}
