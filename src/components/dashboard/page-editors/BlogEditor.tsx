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

export function BlogEditor({ slug, sectionId, content, onContentUpdate }: EditorProps) {
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
          placeholder="Tips & care"
          onChange={e => handleChange({ section_title: e.target.value })}
        />
      </div>
      <div>
        <label className={labelClass}>Số bài viết hiển thị</label>
        <select
          className={selectClass}
          value={typeof content.post_count === "number" ? String(content.post_count) : "3"}
          onChange={e => handleChange({ post_count: Number(e.target.value) as 3 | 6 })}
        >
          <option value="3">3</option>
          <option value="6">6</option>
        </select>
      </div>
      <p className="text-xs text-[#a1a1aa]/60 italic">Quản lý bài viết — Phase 2</p>
    </div>
  );
}
