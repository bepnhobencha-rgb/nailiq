import { redirect } from "next/navigation";

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ range?: string | string[] }>;
};

/**
 * Compatibility route for bookmarks and older dashboard links.
 *
 * Some browser content blockers classify a path segment literally named
 * `reports` as telemetry and block the App Router's follow-up request. Keep the
 * product route on `/insights` while preserving old URLs through a server
 * redirect that runs before any client hydration.
 */
export default async function LegacyReportsRedirect({
  params,
  searchParams,
}: PageProps) {
  const { slug } = await params;
  const rawRange = (await searchParams).range;
  const candidate = Array.isArray(rawRange) ? rawRange[0] : rawRange;
  const query =
    candidate === "week" || candidate === "month" || candidate === "today"
      ? `?range=${candidate}`
      : "";

  redirect(`/dashboard/${encodeURIComponent(slug)}/insights${query}`);
}
