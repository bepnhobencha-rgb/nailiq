"use client";
import { useState } from "react";
import type { SalonSection } from "@/shared/types/salonPage";
import { HeroEditor } from "@/components/dashboard/page-editors/HeroEditor";
import { ServicesEditor } from "@/components/dashboard/page-editors/ServicesEditor";
import { AboutEditor } from "@/components/dashboard/page-editors/AboutEditor";
import { GalleryEditor } from "@/components/dashboard/page-editors/GalleryEditor";
import { PromotionsEditor } from "@/components/dashboard/page-editors/PromotionsEditor";
import { ContactEditor } from "@/components/dashboard/page-editors/ContactEditor";
import { BlogEditor } from "@/components/dashboard/page-editors/BlogEditor";

const TABS = ["Nội dung", "Thiết kế", "SEO"] as const;
type Tab = typeof TABS[number];

export function PageEditorSectionEditor({ slug, salonId, section, onContentUpdate }: {
  slug: string;
  salonId: string;
  section: SalonSection;
  onContentUpdate: (content: Record<string, unknown>) => void;
}) {
  const [activeTab, setActiveTab] = useState<Tab>("Nội dung");

  return (
    <div className="rounded-xl border border-white/10 bg-[#111214] overflow-hidden">
      {/* Tab bar */}
      <div className="flex border-b border-white/10">
        {TABS.map(tab => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-3 text-sm font-medium transition-colors ${activeTab === tab ? "text-[#d4af37] border-b-2 border-[#d4af37] -mb-px" : "text-[#a1a1aa] hover:text-white"}`}
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="p-5">
        {activeTab !== "Nội dung" ? (
          <p className="text-sm text-[#a1a1aa] text-center py-8">Coming soon</p>
        ) : (
          <EditorContent slug={slug} salonId={salonId} section={section} onContentUpdate={onContentUpdate} />
        )}
      </div>
    </div>
  );
}

function EditorContent({
  slug,
  salonId,
  section,
  onContentUpdate,
}: {
  slug: string;
  salonId: string;
  section: SalonSection;
  onContentUpdate: (c: Record<string, unknown>) => void;
}) {
  const props = { slug, salonId, sectionId: section.id, content: section.content, onContentUpdate };
  switch (section.type) {
    case "hero":       return <HeroEditor {...props} />;
    case "services":   return <ServicesEditor {...props} />;
    case "about":      return <AboutEditor {...props} />;
    case "gallery":    return <GalleryEditor {...props} />;
    case "promotions": return <PromotionsEditor {...props} />;
    case "contact":    return <ContactEditor {...props} />;
    case "blog":       return <BlogEditor {...props} />;
    default:           return <p className="text-[#a1a1aa] text-sm">Unknown section type</p>;
  }
}
