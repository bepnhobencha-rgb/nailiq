"use client";
import { GripVertical, Eye, EyeOff, Sparkles, Scissors, Info, Image, Tag, Phone, FileText } from "lucide-react";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { SalonSection, SectionType } from "@/shared/types/salonPage";

const ICONS: Record<SectionType, React.ElementType> = {
  hero: Sparkles, services: Scissors, about: Info,
  gallery: Image, promotions: Tag, contact: Phone, blog: FileText,
};

function SortableRow({ section, isSelected, onSelect, onToggle }: {
  section: SalonSection;
  isSelected: boolean;
  onSelect: () => void;
  onToggle: (visible: boolean) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: section.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const Icon = ICONS[section.type as SectionType] ?? Info;
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 rounded-lg border p-3 cursor-pointer mb-2 transition-colors ${isSelected ? "border-[#d4af37]/60 bg-[#d4af37]/5" : "border-white/10 bg-[#18191c] hover:border-white/20"}`}
      onClick={onSelect}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="cursor-grab touch-none text-[#a1a1aa]/40 hover:text-[#a1a1aa] shrink-0"
        onClick={e => e.stopPropagation()}
      >
        <GripVertical size={14} />
      </button>
      <Icon size={14} className={isSelected ? "text-[#d4af37]" : "text-[#a1a1aa]"} />
      <span className="flex-1 min-w-0 text-sm text-white truncate">{section.title}</span>
      <button
        type="button"
        className="shrink-0 text-[#a1a1aa]/60 hover:text-[#a1a1aa]"
        onClick={e => { e.stopPropagation(); onToggle(!section.is_visible); }}
      >
        {section.is_visible ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
    </div>
  );
}

export function PageEditorSectionList({ sections, selectedId, onSelect, onToggle, onReorder }: {
  sections: SalonSection[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string, visible: boolean) => void;
  onReorder: (sections: SalonSection[]) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = sections.findIndex(s => s.id === active.id);
    const newIdx = sections.findIndex(s => s.id === over.id);
    onReorder(arrayMove(sections, oldIdx, newIdx));
  }

  return (
    <div className="rounded-xl border border-white/10 bg-[#111214] p-3">
      <p className="text-xs text-[#a1a1aa] font-medium mb-3 px-1">SECTIONS</p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={sections.map(s => s.id)} strategy={verticalListSortingStrategy}>
          {sections.map(s => (
            <SortableRow
              key={s.id}
              section={s}
              isSelected={s.id === selectedId}
              onSelect={() => onSelect(s.id)}
              onToggle={(v) => onToggle(s.id, v)}
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}
