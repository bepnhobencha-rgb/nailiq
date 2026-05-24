"use client";
import { useState, useRef, useCallback } from "react";
import { Plus, X, Upload } from "lucide-react";
import { updateSectionContent, uploadSectionImage } from "@/shared/dashboard/pageEditorActions";

type SaveStatus = "idle" | "saving" | "saved" | "error";

type EditorProps = {
  slug: string;
  salonId: string;
  sectionId: string;
  content: Record<string, unknown>;
  onContentUpdate: (c: Record<string, unknown>) => void;
};

type GalleryImage = { url: string; alt?: string };

const inputClass = "w-full rounded-lg bg-[#1c1c1e] border border-white/10 px-3 py-2 text-sm text-white placeholder-[#a1a1aa]/40 focus:outline-none focus:border-[#d4af37]/40";
const labelClass = "text-xs text-[#a1a1aa] mb-1 block";
const selectClass = "w-full rounded-lg bg-[#1c1c1e] border border-white/10 px-3 py-2 text-sm text-white focus:outline-none focus:border-[#d4af37]/40";

function parseImages(raw: unknown): GalleryImage[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((i): i is GalleryImage => typeof i === "object" && i !== null && typeof (i as GalleryImage).url === "string");
}

export function GalleryEditor({ slug, sectionId, content, onContentUpdate }: EditorProps) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [uploadingIdx, setUploadingIdx] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingUploadIdx = useRef<number | null>(null);
  const images = parseImages(content.images);

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

  function handleImageChange(idx: number, url: string) {
    const newImages = images.map((img, i) => i === idx ? { ...img, url } : img);
    handleChange({ images: newImages });
  }

  function handleAddImage() {
    if (images.length >= 12) return;
    handleChange({ images: [...images, { url: "" }] });
  }

  function handleRemoveImage(idx: number) {
    handleChange({ images: images.filter((_, i) => i !== idx) });
  }

  function triggerUpload(idx: number) {
    pendingUploadIdx.current = idx;
    fileInputRef.current?.click();
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const idx = pendingUploadIdx.current;
    if (!file || idx === null) return;
    if (fileInputRef.current) fileInputRef.current.value = "";
    setUploadingIdx(idx);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("type", `gallery-${idx}`);
    const result = await uploadSectionImage(slug, fd);
    setUploadingIdx(null);
    if (result.ok && result.url) {
      const newImages = images.map((img, i) => i === idx ? { ...img, url: result.url! } : img);
      handleChange({ images: newImages });
    }
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
          placeholder="Our work"
          onChange={e => handleChange({ section_title: e.target.value })}
        />
      </div>
      <div>
        <label className={labelClass}>Kiểu lưới</label>
        <select
          className={selectClass}
          value={typeof content.grid_style === "string" ? content.grid_style : "3-col"}
          onChange={e => handleChange({ grid_style: e.target.value })}
        >
          <option value="3-col">3 cột</option>
          <option value="2-col">2 cột</option>
          <option value="masonry">Masonry</option>
          <option value="slideshow">Slideshow</option>
        </select>
      </div>
      <div>
        <label className={labelClass}>Ảnh</label>
        <div className="flex flex-col gap-2">
          {images.map((img, idx) => (
            <div key={idx} className="flex items-center gap-2">
              {img.url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={img.url} alt="" className="h-10 w-14 rounded object-cover border border-white/10 shrink-0" />
              )}
              <input
                type="text"
                className={inputClass}
                value={img.url}
                placeholder="https://..."
                onChange={e => handleImageChange(idx, e.target.value)}
              />
              <button
                type="button"
                disabled={uploadingIdx === idx}
                onClick={() => triggerUpload(idx)}
                className="shrink-0 text-[#a1a1aa]/60 hover:text-[#d4af37] transition-colors disabled:opacity-40"
                title="Upload"
              >
                {uploadingIdx === idx ? <span className="text-xs">…</span> : <Upload size={13} />}
              </button>
              <button
                type="button"
                className="shrink-0 text-[#a1a1aa]/60 hover:text-red-400 transition-colors"
                onClick={() => handleRemoveImage(idx)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
          {images.length < 12 && (
            <button
              type="button"
              className="flex items-center gap-1.5 text-xs text-[#d4af37] hover:text-[#d4af37]/80 transition-colors mt-1"
              onClick={handleAddImage}
            >
              <Plus size={13} />
              Thêm ảnh{images.length > 0 ? ` (${images.length}/12)` : ""}
            </button>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>
    </div>
  );
}
