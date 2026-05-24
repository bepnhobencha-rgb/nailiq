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

export function HeroEditor({ slug, sectionId, content, onContentUpdate }: EditorProps) {
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
        <label className={labelClass}>Tiêu đề</label>
        <input
          type="text"
          className={inputClass}
          value={typeof content.heading === "string" ? content.heading : ""}
          placeholder="Welcome"
          onChange={e => handleChange({ heading: e.target.value })}
        />
      </div>
      <div>
        <label className={labelClass}>Mô tả phụ</label>
        <input
          type="text"
          className={inputClass}
          value={typeof content.subheading === "string" ? content.subheading : ""}
          placeholder="Salon của bạn"
          onChange={e => handleChange({ subheading: e.target.value })}
        />
      </div>
      <div>
        <label className={labelClass}>Nút CTA</label>
        <input
          type="text"
          className={inputClass}
          value={typeof content.cta_text === "string" ? content.cta_text : ""}
          placeholder="Book now"
          onChange={e => handleChange({ cta_text: e.target.value })}
        />
      </div>
      <div>
        <label className={labelClass}>URL ảnh nền</label>
        <input
          type="text"
          className={inputClass}
          value={typeof content.bg_image_url === "string" ? content.bg_image_url : ""}
          placeholder="https://..."
          onChange={e => handleChange({ bg_image_url: e.target.value || null })}
        />
      </div>
    </div>
  );
}
