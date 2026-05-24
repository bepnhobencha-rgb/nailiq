"use client";
import { useState, useRef, useCallback } from "react";
import { updateSectionContent } from "@/shared/dashboard/pageEditorActions";
import { ImageUploadField } from "./ImageUploadField";

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

export function AboutEditor({ slug, sectionId, content, onContentUpdate }: EditorProps) {
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
          placeholder="About us"
          onChange={e => handleChange({ section_title: e.target.value })}
        />
      </div>
      <div>
        <label className={labelClass}>Nội dung</label>
        <textarea
          className={textareaClass}
          rows={5}
          value={typeof content.body === "string" ? content.body : ""}
          placeholder="Câu chuyện về salon..."
          onChange={e => handleChange({ body: e.target.value })}
        />
      </div>
      <ImageUploadField
        slug={slug}
        type="about"
        label="Ảnh"
        value={typeof content.image_url === "string" ? content.image_url : ""}
        onChange={(url) => handleChange({ image_url: url })}
      />
      <div>
        <label className={labelClass}>Bố cục</label>
        <select
          className={selectClass}
          value={typeof content.layout === "string" ? content.layout : "image-left"}
          onChange={e => handleChange({ layout: e.target.value })}
        >
          <option value="image-left">Ảnh trái</option>
          <option value="image-right">Ảnh phải</option>
          <option value="image-top">Ảnh trên</option>
        </select>
      </div>
    </div>
  );
}
