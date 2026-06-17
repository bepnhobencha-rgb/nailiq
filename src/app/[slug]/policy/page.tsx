import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { resolvePolicy, type StoredPolicy } from "@/shared/lib/cancellationPolicy";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

async function loadSalon(slug: string) {
  const { data } = await createServiceRoleClient()
    .from("salons" as never)
    .select("name, cancellation_policy")
    .eq("slug", slug)
    .maybeSingle();
  return data as { name?: string | null; cancellation_policy?: StoredPolicy } | null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Cancellation Policy · ${slug}`, robots: { index: false } };
}

export default async function PolicyPage({ params }: Props) {
  const { slug } = await params;
  const salon = await loadSalon(slug);
  if (!salon) notFound();
  const salonName = (salon.name ?? "").trim() || slug;
  const en = resolvePolicy(salon.cancellation_policy, "en", salonName);
  const vi = resolvePolicy(salon.cancellation_policy, "vi", salonName);

  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl bg-white px-5 py-12 text-neutral-800">
      <h1 className="text-2xl font-semibold text-neutral-900">{salonName}</h1>
      <p className="mt-1 text-sm text-neutral-500">Cancellation & No-Show Policy · Chính sách huỷ &amp; vắng mặt</p>

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
