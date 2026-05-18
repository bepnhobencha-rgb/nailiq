import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "NailIQ — Booking + walk-in queue for nail salons";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "80px",
          background:
            "linear-gradient(135deg, #0b0c10 0%, #131519 50%, #1a1d24 100%)",
          color: "#ffffff",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: "linear-gradient(135deg, #c9a227, #e8c84a)",
            }}
          />
          <div
            style={{
              fontSize: 36,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              color: "#D4AF37",
            }}
          >
            NailIQ
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          <div
            style={{
              fontSize: 72,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: "-0.03em",
              maxWidth: "920px",
            }}
          >
            Booking + walk-in queue for nail salons
          </div>
          <div
            style={{
              fontSize: 30,
              color: "#94a3b8",
              maxWidth: "880px",
              lineHeight: 1.35,
            }}
          >
            Vietnamese-first salon OS — built in Vancouver, BC 🇨🇦
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 22,
            color: "#64748b",
          }}
        >
          <div>nailiq.ca</div>
          <div>From $39 CAD / month · 14-day free trial</div>
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}
