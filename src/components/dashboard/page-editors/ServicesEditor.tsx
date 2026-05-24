"use client";
import { useState, useRef, useCallback } from "react";
import { updateSectionContent } from "@/shared/dashboard/pageEditorActions";

type SaveStatus = "idle" | "saving" | "saved" | "error";

type EditorProps = {
  slug: string;
  salonId: string;
  sectionId: string;
  content: Record<string, unknown>;
  onContentUpdate: (c: Record<string, unknown>) => void;
};

const inputClass = "w-full rounded-lg bg-[#1c1c1e] border border-white/10 px-3 py-2 text-sm text-white placeholder-[#a1a1aa]/40 focus:outline-none focus:border-[#d4af37]/40";
const labelClass = "text-xs text-[#a1a1aa] mb-1 block";
const selectClass = "w-full rounded-lg bg-[#1c1c1e] border border-white/10 px-3 py-2 text-sm text-white focus:outline-none focus:border-[#d4af37]/40";
const textareaClass = `${inputClass} resize-none`;

export function ServicesEditor({ slug, sectionId, content, onContentUpdate }: EditorProps) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = useCallback(async (newContent: Record<string, unknown>) => {
    setStatus("saving");
    const result = await updateSectionContent(slug, sectionId, newContent);
    setStatus(result.ok ? "saved" : "error");
    setTimeout(() => setStatus("idle"), 2000);
  }, [slug, sectionId]);

  function handleChange(patch: Record<string, unknown>) {
    const newContent = { ...content, ...patch };
    onContentUpdate(newContent);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => save(newContent), 1500);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        {status === "saving" && <span className="text-xs text-[#a1a1aa]">Đang lưu...</span>}
        {status === "saved" && <span className="text-xs text-green-500">Đã lưu ✓</span>}
        {status === "error" && <span className="text-xs text-red-400">Lỗi lưu</span>}
      </div>
      <div>
        <label className={labelClass}>Tiêu đề section</label>
        <input
          type="text"
          className={inputClass}
          value={typeof content.section_title === "string" ? content.section_title : ""}
          placeholder="Our services"
          onChange={e => handleChange({ section_title: e.target.value })}
        />
      </div>
      <div>
        <label className={labelClass}>Mô tả</label>
        <textarea
          className={textareaClass}
          rows={3}
          value={typeof content.description === "string" ? content.description : ""}
          placeholder="Chúng tôi cung cấp..."
          onChange={e => handleChange({ description: e.target.value })}
        />
      </div>
      <div>
        <label className={labelClass}>Hiển thị giá</label>
        <select
          className={selectClass}
          value={typeof content.show_price === "string" ? content.show_price : "full"}
          onChange={e => handleChange({ show_price: e.target.value })}
        >
          <option value="full">Giá đầy đủ</option>
          <option value="from-price">Giá từ...</option>
          <option value="hidden">Ẩn giá</option>
        </select>
      </div>
      <div>
        <label className={labelClass}>Số dịch vụ hiển thị</label>
        <select
          className={selectClass}
          value={typeof content.display_count === "string" ? content.display_count : "all"}
          onChange={e => handleChange({ display_count: e.target.value })}
        >
          <option value="all">Tất cả</option>
          <option value="3">3</option>
          <option value="6">6</option>
        </select>
      </div>
      <p className="text-xs text-[#a1a1aa]/60 italic">Chỉnh dịch vụ và giá tại mục Dịch vụ</p>
    </div>
  );
}
