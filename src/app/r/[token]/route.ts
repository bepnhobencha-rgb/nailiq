import { NextResponse } from "next/server";
import { confirmReoptin } from "@/shared/reoptin/reoptinCampaign";

export const dynamic = "force-dynamic";

/**
 * GET /r/<token> — the re-opt-in email CTA target.
 *
 * Stamps full marketing consent, ensures the welcome voucher exists, then sends
 * the customer straight into the salon's booking flow with the code pre-applied.
 * A bad/expired token just lands them on the home page — never an error screen.
 */
function siteOrigin(req: Request): string {
  const env =
    (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  if (env) return env.replace(/\/$/, "");
  return new URL(req.url).origin;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const base = siteOrigin(req);

  const result = await confirmReoptin((token ?? "").trim());
  if (!result.ok) {
    return NextResponse.redirect(`${base}/`, { status: 302 });
  }

  const q = new URLSearchParams({ code: result.code, ref: "reoptin" });
  return NextResponse.redirect(`${base}/${result.slug}?${q.toString()}#book`, {
    status: 302,
  });
}
