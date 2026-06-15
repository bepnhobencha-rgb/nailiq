import { ImageResponse } from "next/og";
import { getSalonPwaInfo } from "@/shared/dashboard/salonPwaInfo";

// Service-role read needs the Node runtime (not edge).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-tenant installable-app icon for the dashboard PWA. There's no salon
 * logo column, so we generate a branded mark: the salon's brand colour as a
 * full-bleed background (maskable-safe) with its initials. `?size=` controls
 * the square edge (default 512; manifest also requests 192).
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const url = new URL(req.url);
  const size = Math.min(
    1024,
    Math.max(48, parseInt(url.searchParams.get("size") ?? "512", 10) || 512),
  );

  const info = await getSalonPwaInfo(slug);
  const brand = info?.brandColor ?? "#D4AF37";
  const initials = info?.initials ?? "NQ";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          // Brand colour fills the whole tile so it survives the circular /
          // squircle mask Android + iOS apply.
          background: `radial-gradient(circle at 50% 38%, ${brand} 0%, ${brand} 55%, rgba(0,0,0,0.28) 100%)`,
          color: "#ffffff",
          fontFamily: "system-ui, -apple-system, sans-serif",
          fontWeight: 800,
          fontSize: Math.round(size * 0.42),
          letterSpacing: "-0.03em",
          textShadow: "0 2px 8px rgba(0,0,0,0.35)",
        }}
      >
        {initials}
      </div>
    ),
    { width: size, height: size },
  );
}
