"use client";

import { useRef, useState } from "react";
import { Upload, X } from "lucide-react";
import { uploadSectionImage } from "@/shared/dashboard/pageEditorActions";

type Props = {
  slug: string;
  type: string;
  value: string;
  onChange: (url: string | null) => void;
  label: string;
  placeholder?: string;
};

export function ImageUploadField({ slug, type, value, onChange, label, placeholder }: Props) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const inputClass =
    "w-full rounded-lg bg-[#1c1c1e] border border-white/10 px-3 py-2 text-sm text-white placeholder-[#a1a1aa]/40 focus:outline-none focus:border-[#d4af37]/40";
  const labelClass = "text-xs text-[#a1a1aa] mb-1 block";

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("type", type);
      const result = await uploadSectionImage(slug, fd);
      if (result.ok && result.url) {
        onChange(result.url);
      } else {
        setUploadError(
          result.error === "file_too_large"
            ? "File > 5MB"
            : result.error === "invalid_type"
              ? "Chỉ JPG/PNG/WebP/GIF"
              : "Upload thất bại",
        );
      }
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div>
      <label className={labelClass}>{label}</label>
      {value ? (
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={value}
            alt=""
            className="h-14 w-20 rounded object-cover border border-white/10"
          />
          <button
            type="button"
            className="text-[#a1a1aa]/60 hover:text-red-400 transition-colors"
            onClick={() => onChange(null)}
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <input
            type="text"
            className={inputClass}
            value={value}
            placeholder={placeholder ?? "https://..."}
            onChange={(e) => onChange(e.target.value || null)}
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg border border-white/10 bg-[#1c1c1e] text-xs text-[#a1a1aa] hover:border-[#d4af37]/40 hover:text-white disabled:opacity-50 transition-colors"
          >
            <Upload size={12} />
            {uploading ? "…" : "Upload"}
          </button>
        </div>
      )}
      {uploadError && <p className="mt-1 text-xs text-red-400">{uploadError}</p>}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        onChange={handleFileChange}
      />
    </div>
  );
}
