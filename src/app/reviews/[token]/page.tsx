import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReviewForm } from "@/components/reviews/ReviewForm";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Đánh giá dịch vụ",
  robots: { index: false, follow: false },
};

type PageProps = {
  params: Promise<{ token: string }>;
};

/**
 * Public review form. Authenticated solely by the opaque `token` in
 * the URL — no Supabase auth. This server component resolves the token with a
 * server-only service-role client; the reviews base table is never public.
 */
export default async function ReviewByTokenPage({ params }: PageProps) {
  const { token } = await params;
  if (!token || token.length < 16) {
    notFound();
  }

  const supabase = createServiceRoleClient();
  const { data: row } = await supabase
    .from("reviews")
    .select(
      `
      id, rating, message, submitted_at, request_token,
      salons!inner ( name, slug ),
      services ( name ),
      staff ( name )
    `,
    )
    .eq("request_token", token)
    .maybeSingle();

  if (!row) {
    notFound();
  }

  type Salon = { name: string | null; slug: string };
  const salonRaw = (row as unknown as { salons: Salon | Salon[] | null }).salons;
  const salon: Salon | null = Array.isArray(salonRaw)
    ? (salonRaw[0] ?? null)
    : (salonRaw ?? null);
  type Service = { name: string | null };
  const svcRaw = (row as unknown as { services: Service | Service[] | null })
    .services;
  const service: Service | null = Array.isArray(svcRaw)
    ? (svcRaw[0] ?? null)
    : (svcRaw ?? null);
  type Staff = { name: string | null };
  const staffRaw = (row as unknown as { staff: Staff | Staff[] | null }).staff;
  const staff: Staff | null = Array.isArray(staffRaw)
    ? (staffRaw[0] ?? null)
    : (staffRaw ?? null);

  const salonName = (salon?.name ?? "").trim() || salon?.slug || "NailIQ";
  const submittedAt =
    (row as { submitted_at?: string | null }).submitted_at ?? null;
  const existingRating =
    (row as { rating?: number | null }).rating ?? null;

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-5 py-12 md:px-8">
      <header className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-nq-muted">
          NailIQ · {salonName}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
          Cảm ơn bạn — chia sẻ trải nghiệm
        </h1>
        <p className="text-sm text-nq-muted">
          {service?.name ? (
            <>
              Dịch vụ <strong>{service.name}</strong>
              {staff?.name ? (
                <>
                  {" "}
                  với <strong>{staff.name}</strong>
                </>
              ) : null}
              .
            </>
          ) : (
            <>Vui lòng đánh giá lần ghé này — chỉ mất 30 giây.</>
          )}
        </p>
      </header>

      {submittedAt ? (
        <div className="rounded-md border border-nq-success/40 bg-nq-success/15 px-4 py-3 text-sm text-nq-success">
          <p className="font-semibold">Đã ghi nhận đánh giá của bạn</p>
          <p className="mt-1 text-nq-success/85">
            Bạn đã đánh giá {existingRating ?? "—"}/5. Cảm ơn rất nhiều.
          </p>
        </div>
      ) : (
        <ReviewForm token={token} />
      )}
    </main>
  );
}
