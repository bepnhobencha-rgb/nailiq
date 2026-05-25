import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createClient } from "@/shared/lib/supabase/server";
import { GiftCardPurchasePanel } from "@/components/booking/GiftCardPurchasePanel";
import { getSiteUrl } from "@/shared/seo/site";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const supabase = await createClient();
  const { data } = await supabase
    .from("salons" as never)
    .select("name")
    .eq("slug", slug)
    .is("archived_at" as never, null)
    .maybeSingle();
  const name = (data as { name?: string } | null)?.name ?? slug;
  return {
    title: `Gift Cards — ${name}`,
    description: `Purchase a gift card for ${name}. Perfect for any occasion.`,
    alternates: { canonical: `${getSiteUrl()}/${slug}/gift` },
  };
}

export default async function GiftCardPage({ params }: Props) {
  const { slug } = await params;
  const supabase = await createClient();

  const { data: salon } = await supabase
    .from("salons" as never)
    .select("id, name, slug, brand_color, theme_mode, profile_complete")
    .eq("slug", slug)
    .is("archived_at" as never, null)
    .maybeSingle();

  if (!salon) notFound();

  const typedSalon = salon as {
    id: string;
    name: string;
    slug: string;
    brand_color: string | null;
    theme_mode: string | null;
    profile_complete: boolean;
  };

  const brandColor = typedSalon.brand_color ?? "#D4AF37";
  const isLight = typedSalon.theme_mode === "light";

  return (
    <div
      className="min-h-dvh"
      style={{
        background: isLight ? "#f9f9f9" : "#0a0a0a",
        color: isLight ? "#1a1a1a" : "#ffffff",
        "--salon-primary": brandColor,
      } as React.CSSProperties}
    >
      <div className="mx-auto max-w-lg px-4 py-12">
        <a
          href={`/${slug}`}
          className="text-sm text-[#a1a1aa] hover:text-white transition-colors mb-8 inline-block"
        >
          ← Back to booking
        </a>
        <GiftCardPurchasePanel slug={slug} salonName={typedSalon.name} brandColor={brandColor} />
      </div>
    </div>
  );
}
