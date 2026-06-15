import { getSalonPwaInfo } from "@/shared/dashboard/salonPwaInfo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-tenant web app manifest so the salon's dashboard installs to the
 * phone home screen as its OWN app — salon name, brand colour theme, generated
 * branded icon, and a standalone (no browser chrome) launch. Scoped to this
 * salon's dashboard so the installed app stays inside it.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const info = await getSalonPwaInfo(slug);
  const seg = encodeURIComponent(slug);
  const name = info?.name ?? "NailIQ";

  const manifest = {
    name: `${name} — Dashboard`,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    description: `Manage ${name} — live board, bookings, and salon pulse.`,
    start_url: `/dashboard/${seg}`,
    scope: `/dashboard/${seg}`,
    display: "standalone",
    orientation: "portrait",
    background_color: "#0B0C10",
    // Dark chrome matches the dashboard so the standalone status bar blends —
    // the per-tenant branding lives in the icon + app name.
    theme_color: "#0B0C10",
    icons: [
      {
        src: `/dashboard/${seg}/icon?size=192`,
        sizes: "192x192",
        type: "image/png",
        purpose: "any maskable",
      },
      {
        src: `/dashboard/${seg}/icon?size=512`,
        sizes: "512x512",
        type: "image/png",
        purpose: "any maskable",
      },
    ],
  };

  return new Response(JSON.stringify(manifest), {
    headers: {
      "Content-Type": "application/manifest+json",
      "Cache-Control": "public, max-age=300",
    },
  });
}
