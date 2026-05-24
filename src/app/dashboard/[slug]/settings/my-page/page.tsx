import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { PageEditorPanel } from "@/components/dashboard/PageEditorPanel";
import type { SalonSection } from "@/shared/types/salonPage";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  return { title: `My Page · ${slug}`, robots: "noindex" };
}

export default async function MyPageEditorPage({ params }: PageProps) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");

  const { supabase, salon } = ctx;

  // Seed if first visit
  const { count } = await supabase
    .from("salon_page_sections" as never)
    .select("id", { count: "exact", head: true })
    .eq("salon_id", salon.id);

  if ((count ?? 0) === 0) {
    await supabase.rpc("seed_default_page_sections" as never, { p_salon_id: salon.id } as never);
  }

  const { data: sections } = await supabase
    .from("salon_page_sections" as never)
    .select("id, type, title, is_visible, sort_order, content, updated_at, salon_id")
    .eq("salon_id", salon.id)
    .order("sort_order", { ascending: true });

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">My Page</h1>
          <p className="text-sm text-[#a1a1aa] mt-1">Quản lý nội dung trang đặt lịch công khai</p>
        </div>
        <a
          href={`/dashboard/${slug}/import`}
          className="shrink-0 px-4 py-2 text-sm font-medium rounded-lg border border-[#D4AF37]/40 text-[#D4AF37] hover:bg-[#D4AF37]/10 transition-colors"
        >
          Import from website
        </a>
      </div>
      <PageEditorPanel
        slug={slug}
        salonId={salon.id}
        initialSections={(sections ?? []) as SalonSection[]}
      />
    </div>
  );
}
