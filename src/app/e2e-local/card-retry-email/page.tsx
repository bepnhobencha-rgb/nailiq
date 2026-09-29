import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { CardRetryEmailHarness } from "./CardRetryEmailHarness";
export const dynamic = "force-dynamic";
export default async function Page() {
  const host = (await headers()).get("host")?.trim() ?? "";
  if (process.env.NODE_ENV !== "development" || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) notFound();
  return <CardRetryEmailHarness />;
}
