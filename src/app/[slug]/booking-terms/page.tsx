import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { bookingTerms } from "@/shared/lib/bookingTerms";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Booking Terms · ${slug}`, robots: { index: false } };
}

export default async function BookingTermsPage({ params }: Props) {
  const { slug } = await params;
  const { data } = await createServiceRoleClient()
    .from("salons" as never)
    .select("name, vertical")
    .eq("slug", slug)
    .maybeSingle();
  if (!data) notFound();
  const row = data as { name?: string | null; vertical?: string | null };
  const salonName = (row.name ?? "").trim() || slug;
  const en = bookingTerms("en", salonName, row.vertical);
  const vi = bookingTerms("vi", salonName, row.vertical);

  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl bg-white px-5 py-12 text-neutral-800">
      <h1 className="text-2xl font-semibold text-neutral-900">{salonName}</h1>
      <p className="mt-1 text-sm text-neutral-600">Booking Terms · Điều khoản đặt lịch</p>
      <p className="mt-2 text-sm">
        <a href={`/${slug}/policy`} className="text-neutral-700 underline">
          Cancellation &amp; No-Show Policy · Chính sách huỷ &amp; vắng mặt →
        </a>
      </p>

      <section className="mt-8">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-600">English</h2>
        <pre className="mt-2 whitespace-pre-wrap font-sans text-sm leading-relaxed text-neutral-700">{en}</pre>
      </section>

      <section className="mt-8 border-t border-neutral-200 pt-8">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-600">Tiếng Việt</h2>
        <pre className="mt-2 whitespace-pre-wrap font-sans text-sm leading-relaxed text-neutral-700">{vi}</pre>
      </section>
    </main>
  );
}
