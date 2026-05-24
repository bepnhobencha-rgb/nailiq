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

export function ContactEditor({ slug, sectionId, content, onContentUpdate }: EditorProps) {
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

  const showMap = content.show_map !== false;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        {status === "saving" && <span className="text-xs text-[#a1a1aa]">Đang lưu...</span>}
        {status === "saved" && <span className="text-xs text-green-500">Đã lưu ✓</span>}
        {status === "error" && <span className="text-xs text-red-400">Lỗi lưu</span>}
      </div>
      <div>
        <label className={labelClass}>Địa chỉ</label>
        <input
          type="text"
          className={inputClass}
          value={typeof content.address === "string" ? content.address : ""}
          placeholder="123 Đường ABC, Quận 1, TP.HCM"
          onChange={e => handleChange({ address: e.target.value })}
        />
      </div>
      <div>
        <label className={labelClass}>Số điện thoại</label>
        <input
          type="text"
          className={inputClass}
          value={typeof content.phone === "string" ? content.phone : ""}
          placeholder="+84 xxx xxx xxx"
          onChange={e => handleChange({ phone: e.target.value })}
        />
      </div>
      <div>
        <label className={labelClass}>Email</label>
        <input
          type="text"
          className={inputClass}
          value={typeof content.email === "string" ? content.email : ""}
          placeholder="hello@salon.com"
          onChange={e => handleChange({ email: e.target.value })}
        />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm text-white">Hiển thị bản đồ</span>
        <button
          type="button"
          onClick={() => handleChange({ show_map: !showMap })}
          className={`w-10 h-6 rounded-full transition-colors ${showMap ? "bg-[#d4af37]" : "bg-white/20"}`}
        >
          <span className={`block w-4 h-4 rounded-full bg-white mx-auto transition-transform ${showMap ? "translate-x-2" : "-translate-x-2"}`} />
        </button>
      </div>
    </div>
  );
}
