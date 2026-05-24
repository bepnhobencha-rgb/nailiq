"use client";
import { useState } from "react";
import type { SalonSection } from "@/shared/types/salonPage";
import { PageEditorSectionList } from "@/components/dashboard/PageEditorSectionList";
import { PageEditorSectionEditor } from "@/components/dashboard/PageEditorSectionEditor";
import { toggleSectionVisibility, updateSectionOrder } from "@/shared/dashboard/pageEditorActions";

export function PageEditorPanel({ slug, salonId, initialSections }: {
  slug: string;
  salonId: string;
  initialSections: SalonSection[];
}) {
  const [sections, setSections] = useState(initialSections);
  const [selectedId, setSelectedId] = useState<string | null>(initialSections[0]?.id ?? null);

  const selectedSection = sections.find(s => s.id === selectedId) ?? null;

  async function handleToggle(id: string, visible: boolean) {
    // Optimistic
    setSections(prev => prev.map(s => s.id === id ? { ...s, is_visible: visible } : s));
    await toggleSectionVisibility(slug, id, visible);
  }

  async function handleReorder(newSections: SalonSection[]) {
    setSections(newSections);
    await updateSectionOrder(slug, newSections.map((s, i) => ({ id: s.id, sort_order: i })));
  }

  function handleContentUpdate(id: string, content: Record<string, unknown>) {
    setSections(prev => prev.map(s => s.id === id ? { ...s, content } : s));
  }

  return (
    <div className="flex gap-4 min-h-[600px]">
      <div className="w-[260px] flex-shrink-0">
        <PageEditorSectionList
          sections={sections}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onToggle={handleToggle}
          onReorder={handleReorder}
        />
      </div>
      <div className="flex-1 min-w-0">
        {selectedSection ? (
          <PageEditorSectionEditor
            slug={slug}
            salonId={salonId}
            section={selectedSection}
            onContentUpdate={(content) => handleContentUpdate(selectedSection.id, content)}
          />
        ) : (
          <div className="rounded-xl border border-white/10 bg-[#111214] p-8 text-center text-[#a1a1aa]">
            Chọn một section để chỉnh sửa
          </div>
        )}
      </div>
    </div>
  );
}
