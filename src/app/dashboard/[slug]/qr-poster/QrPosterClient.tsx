"use client";

type Props = {
  salonName: string;
  bookingUrl: string;
  slug: string;
};

export function QrPosterClient({ salonName, bookingUrl }: Props) {
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(bookingUrl)}&size=280x280&margin=16`;

  return (
    <>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; margin: 0; padding: 0; }
          .poster-wrapper { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        }
      `}</style>

      {/* Screen controls */}
      <div className="no-print flex min-h-screen flex-col items-center justify-center gap-6 bg-[#111214] px-4 py-12">
        <div className="flex w-full max-w-xs flex-col items-center gap-4">
          <button
            type="button"
            onClick={() => window.print()}
            className="w-full rounded-xl bg-[#d4af37] px-6 py-3 text-sm font-semibold text-black transition-opacity hover:opacity-90"
          >
            In poster
          </button>
          <button
            type="button"
            onClick={() => window.history.back()}
            className="w-full rounded-xl border border-white/10 bg-[#18191c] px-6 py-3 text-sm text-[#a1a1aa] transition-colors hover:border-white/20 hover:text-white"
          >
            ← Quay lại
          </button>
        </div>

        {/* Poster preview */}
        <PosterCard salonName={salonName} bookingUrl={bookingUrl} qrSrc={qrSrc} />
      </div>

      {/* Print-only wrapper */}
      <div className="poster-wrapper hidden print:flex print:items-center print:justify-center">
        <PosterCard salonName={salonName} bookingUrl={bookingUrl} qrSrc={qrSrc} />
      </div>
    </>
  );
}

function PosterCard({
  salonName,
  bookingUrl,
  qrSrc,
}: {
  salonName: string;
  bookingUrl: string;
  qrSrc: string;
}) {
  return (
    <div
      style={{
        width: 420,
        background: "#ffffff",
        borderRadius: 20,
        padding: "40px 36px 32px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 0,
        boxShadow: "0 4px 40px rgba(0,0,0,0.18)",
      }}
    >
      {/* Decorative top accent */}
      <div
        style={{
          width: 48,
          height: 4,
          background: "#d4af37",
          borderRadius: 999,
          marginBottom: 24,
        }}
      />

      {/* Salon name */}
      <p
        style={{
          fontSize: 26,
          fontWeight: 700,
          color: "#111214",
          textAlign: "center",
          margin: "0 0 8px 0",
          lineHeight: 1.2,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        }}
      >
        {salonName}
      </p>

      {/* Subtitle */}
      <p
        style={{
          fontSize: 14,
          color: "#71717a",
          textAlign: "center",
          margin: "0 0 28px 0",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        }}
      >
        Quét mã để đặt lịch
      </p>

      {/* QR code */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={qrSrc}
        alt={`QR code for ${salonName}`}
        width={280}
        height={280}
        style={{
          borderRadius: 12,
          border: "1px solid #e4e4e7",
          display: "block",
        }}
      />

      {/* Booking URL */}
      <p
        style={{
          fontSize: 11,
          color: "#a1a1aa",
          textAlign: "center",
          margin: "16px 0 0 0",
          wordBreak: "break-all",
          fontFamily: "monospace",
        }}
      >
        {bookingUrl}
      </p>

      {/* Divider */}
      <div
        style={{
          width: "100%",
          height: 1,
          background: "#f4f4f5",
          margin: "20px 0 16px 0",
        }}
      />

      {/* NailIQ watermark */}
      <p
        style={{
          fontSize: 11,
          color: "#a1a1aa",
          textAlign: "center",
          margin: 0,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          letterSpacing: "0.04em",
        }}
      >
        Powered by{" "}
        <span style={{ color: "#d4af37", fontWeight: 600 }}>NailIQ</span>
      </p>
    </div>
  );
}
