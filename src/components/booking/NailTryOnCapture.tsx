"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Check, ImagePlus, RotateCcw, ShieldCheck } from "lucide-react";
import {
  evaluateClientImageQuality,
  inspectPixels,
  type ClientQualityCode,
} from "@/shared/nailTryOn/imageQuality";
import { DEFAULT_NAIL_CONFIGURATION, type NailConfiguration } from "@/shared/nailTryOn/configurator";
import {
  fetchNailTryOn,
  NAIL_TRYON_CATALOG_CLIENT_TIMEOUT_MS,
  NAIL_TRYON_GENERATION_CLIENT_TIMEOUT_MS,
  NAIL_TRYON_UPLOAD_CLIENT_TIMEOUT_MS,
  NailTryOnRequestTimeoutError,
} from "@/shared/nailTryOn/timeouts";

const COPY: Record<Exclude<ClientQualityCode, "pass">, string> = {
  unsupported_format: "Use a JPEG, PNG, or WebP image. / Hãy dùng ảnh JPEG, PNG hoặc WebP.",
  file_too_large: "This photo is over 10 MB. / Ảnh lớn hơn 10 MB.",
  resolution_too_low: "Move closer—the hand needs more detail. / Hãy chụp gần hơn để thấy rõ móng.",
  resolution_too_high: "Choose a smaller image. / Hãy chọn ảnh có kích thước nhỏ hơn.",
  too_dark: "The preview may be less accurate in low light. / Ảnh tối có thể làm kết quả kém chính xác.",
  too_bright: "Glare may reduce preview accuracy. / Ánh sáng chói có thể làm kết quả kém chính xác.",
  blurred: "This photo looks a little soft, but you may continue. / Ảnh hơi mờ nhưng bạn vẫn có thể tiếp tục.",
};

const BLOCKING_CLIENT_CODES = new Set<ClientQualityCode>([
  "unsupported_format", "file_too_large", "resolution_too_low", "resolution_too_high",
]);

type Props = {
  salonName: string;
  salonSlug: string;
  brandColor: string;
};

type CatalogDesign = { id: string; name: string; description: string | null; previewUrl: string | null };
const LENGTHS: Array<{ value: NailConfiguration["length"]; label: string }> = [
  { value: "natural", label: "Natural" }, { value: "x_short", label: "X-Short" }, { value: "short", label: "Short" }, { value: "medium", label: "Medium" }, { value: "long", label: "Long" }, { value: "extra_long", label: "X-Long" }, { value: "xx_long", label: "XX-Long" },
];
const LENGTH_HINTS: Record<NailConfiguration["length"], string> = {
  natural: "Keeps your current length / Giữ độ dài hiện tại",
  x_short: "Tiny free edge / Rất ngắn",
  short: "About ⅓ of the nail bed / Khoảng ⅓ thân móng",
  medium: "About ⅔ of the nail bed / Khoảng ⅔ thân móng",
  long: "About 1× the nail bed / Khoảng 1 lần thân móng",
  extra_long: "About 1.5× the nail bed / Khoảng 1,5 lần thân móng",
  xx_long: "About 2× the nail bed / Khoảng 2 lần thân móng",
};
const SHAPES: Array<{ value: NailConfiguration["shape"]; label: string }> = [
  { value: "natural", label: "Natural" }, { value: "square", label: "Square" }, { value: "squoval", label: "Squoval" }, { value: "round", label: "Round" }, { value: "oval", label: "Oval" }, { value: "almond", label: "Almond" }, { value: "coffin", label: "Coffin" }, { value: "ballerina", label: "Ballerina" }, { value: "stiletto", label: "Stiletto" },
];
const COLORS: Array<{ value: NailConfiguration["color"]; label: string; swatch: string }> = [
  { value: "design", label: "Design", swatch: "linear-gradient(135deg,#ef4444,#f9a8d4,#60a5fa)" }, { value: "classic_red", label: "Red", swatch: "#a4161a" }, { value: "soft_pink", label: "Pink", swatch: "#e8b4b8" }, { value: "nude", label: "Nude", swatch: "#d9b49f" }, { value: "milky_white", label: "Milky", swatch: "#f2eee7" }, { value: "burgundy", label: "Burgundy", swatch: "#6f1d2c" }, { value: "brown", label: "Brown", swatch: "#6f4e37" }, { value: "orange", label: "Orange", swatch: "#f97316" }, { value: "yellow", label: "Yellow", swatch: "#facc15" }, { value: "green", label: "Green", swatch: "#2f855a" }, { value: "blue", label: "Blue", swatch: "#2563eb" }, { value: "purple", label: "Purple", swatch: "#7c3aed" }, { value: "black", label: "Black", swatch: "#151515" }, { value: "white", label: "White", swatch: "#ffffff" }, { value: "silver", label: "Silver", swatch: "linear-gradient(135deg,#777,#f8fafc,#9ca3af)" }, { value: "gold", label: "Gold", swatch: "linear-gradient(135deg,#a16207,#fde68a,#ca8a04)" },
];
const FINISHES: Array<{ value: NailConfiguration["finish"]; label: string }> = [
  { value: "glossy", label: "Glossy" }, { value: "matte", label: "Matte" }, { value: "chrome", label: "Chrome" }, { value: "cat_eye", label: "Cat-eye" }, { value: "jelly", label: "Jelly" }, { value: "glazed", label: "Glazed" }, { value: "glitter", label: "Glitter" }, { value: "velvet", label: "Velvet" },
];
const ART_STYLES: Array<{ value: NailConfiguration["artStyle"]; label: string }> = [
  { value: "design", label: "Use design" }, { value: "solid", label: "Solid" }, { value: "french", label: "French" }, { value: "micro_french", label: "Micro French" }, { value: "ombre", label: "Ombré" }, { value: "aura", label: "Aura" },
];
export function NailTryOnCapture({ salonName, salonSlug, brandColor }: Props) {
  const [consented, setConsented] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [quality, setQuality] = useState<ClientQualityCode | "checking" | null>(null);
  const [fileName, setFileName] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [designs, setDesigns] = useState<CatalogDesign[]>([]);
  const [step, setStep] = useState<"capture" | "catalog" | "result">("capture");
  const [busy, setBusy] = useState(false);
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [serverWarning, setServerWarning] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [selectedDesign, setSelectedDesign] = useState<CatalogDesign | null>(null);
  const [generationSeconds, setGenerationSeconds] = useState(0);
  const [configuration, setConfiguration] = useState<NailConfiguration>(DEFAULT_NAIL_CONFIGURATION);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletionMessage, setDeletionMessage] = useState<string | null>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const libraryInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  useEffect(() => {
    if (!busy || step !== "result") return;
    const timer = window.setInterval(() => setGenerationSeconds((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [busy, step]);

  async function inspect(file: File) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    setFileName(file.name || "hand-photo");
    setPhoto(file);
    setDeletionMessage(null);
    setQuality("checking");

    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("canvas_unavailable");
      context.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();
      const pixels = context.getImageData(0, 0, width, height);
      const stats = inspectPixels(pixels.data, width, height);
      setQuality(evaluateClientImageQuality({
        mimeType: file.type,
        bytes: file.size,
        width: Math.round(width / scale),
        height: Math.round(height / scale),
        ...stats,
      }));
    } catch {
      setQuality("unsupported_format");
    }
  }

  function reset() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setQuality(null);
    setFileName("");
    setPhoto(null);
    setServerMessage(null);
    setServerWarning(null);
    if (cameraInputRef.current) cameraInputRef.current.value = "";
    if (libraryInputRef.current) libraryInputRef.current.value = "";
  }

  async function deleteUploadedPhoto() {
    if (!sessionId || deleting) return;
    setDeleting(true);
    setServerMessage(null);
    try {
      const response = await fetch("/api/nail-tryon/session", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const payload = await response.json() as {
        deletion?: "complete" | "queued";
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "delete_failed");

      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setQuality(null);
      setFileName("");
      setPhoto(null);
      setSessionId(null);
      setDesigns([]);
      setStep("capture");
      setResultUrl(null);
      setSelectedDesign(null);
      setServerWarning(null);
      setConsented(false);
      setDeleteConfirmOpen(false);
      if (cameraInputRef.current) cameraInputRef.current.value = "";
      if (libraryInputRef.current) libraryInputRef.current.value = "";
      setDeletionMessage(payload.deletion === "queued"
        ? "Your photo is locked and scheduled for permanent deletion. / Ảnh đã bị khóa và đang được xóa vĩnh viễn."
        : "Your photo was permanently deleted. / Ảnh của bạn đã được xóa vĩnh viễn.");
    } catch {
      setServerMessage("We could not finish deleting the photo. Please try again. / Chưa thể hoàn tất xóa ảnh. Vui lòng thử lại.");
    } finally {
      setDeleting(false);
    }
  }

  async function uploadAndVerify() {
    if (!photo) return;
    setBusy(true);
    setServerMessage(null);
    const form = new FormData();
    form.set("photo", photo);
    form.set("slug", salonSlug);
    form.set("consent_version", "nail-tryon-v1");
    try {
      const response = await fetchNailTryOn(
        "/api/nail-tryon/upload",
        { method: "POST", body: form },
        NAIL_TRYON_UPLOAD_CLIENT_TIMEOUT_MS,
      );
      const payload = await response.json() as { sessionId?: string; quality?: string; warning?: boolean; reason?: string; error?: string };
      if (!response.ok || !payload.sessionId || payload.quality !== "pass") {
        setServerMessage(payload.reason || "We could not verify five visible nails. Retake with one hand, palm down.");
        return;
      }
      if (payload.warning) {
        setServerWarning("We can continue, but the AI result may be less accurate. / Bạn vẫn có thể tiếp tục, nhưng kết quả AI có thể kém chính xác hơn.");
      }
      setSessionId(payload.sessionId);
      const catalogResponse = await fetchNailTryOn(
        `/api/nail-tryon/catalog?slug=${encodeURIComponent(salonSlug)}`,
        {},
        NAIL_TRYON_CATALOG_CLIENT_TIMEOUT_MS,
      );
      const catalog = await catalogResponse.json() as { designs?: CatalogDesign[] };
      setDesigns(catalog.designs || []);
      setStep("catalog");
    } catch (error) {
      setServerMessage(error instanceof NailTryOnRequestTimeoutError
        ? "Photo verification took too long. Please try again. / Kiểm tra ảnh quá lâu. Vui lòng thử lại."
        : "Photo verification is temporarily unavailable. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function generate(designId: string) {
    if (!sessionId) return;
    setSelectedDesign(designs.find((design) => design.id === designId) || null);
    setResultUrl(null);
    setStep("result");
    setBusy(true);
    setGenerationSeconds(0);
    setServerMessage(null);
    try {
      const response = await fetchNailTryOn("/api/nail-tryon/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, designId, configuration }),
      }, NAIL_TRYON_GENERATION_CLIENT_TIMEOUT_MS);
      const payload = await response.json() as { previewUrl?: string; error?: string; retryable?: boolean };
      if (response.status === 409 && payload.error === "generation_in_progress") {
        setServerMessage("Your preview is still finishing. Please wait 15 seconds, then tap the design once. / Ảnh vẫn đang được tạo. Vui lòng đợi 15 giây rồi bấm mẫu một lần.");
        return;
      }
      if (!response.ok || !payload.previewUrl) throw new Error(payload.error || "generation_failed");
      setResultUrl(payload.previewUrl);
    } catch (error) {
      setServerMessage(error instanceof NailTryOnRequestTimeoutError
        ? "The AI preview took too long. Choose the design once to retry. / Ảnh AI mất quá nhiều thời gian. Hãy chọn mẫu một lần để thử lại."
        : "The AI preview could not be created. Tap a design to try again. / Chưa tạo được ảnh AI. Hãy chọn lại mẫu để thử lại.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto w-full max-w-lg">
      <div className="mb-8 text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-black/10 bg-white px-3 py-1 text-xs font-semibold text-neutral-700 shadow-sm">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: brandColor }} />
          {salonName}
        </span>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-neutral-950">Try on your next nail look</h1>
        <p className="mt-2 text-sm leading-6 text-neutral-600">One clear photo. Palm down, fingers relaxed, all five nails visible.</p>
      </div>

      {step === "catalog" ? (
        <section className="rounded-3xl border border-neutral-200 bg-white p-5 shadow-xl shadow-black/5 sm:p-7">
          <p className="text-xs font-semibold uppercase tracking-widest text-neutral-500">Step 2 of 3</p>
          <h2 className="mt-2 text-2xl font-semibold text-neutral-950">Build your nail look</h2>
          {serverWarning ? <p className="mt-4 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900" role="status">{serverWarning}</p> : null}
          <div className="mt-5 space-y-5">
            <fieldset><legend className="text-sm font-semibold text-neutral-900">1. Length / Độ dài</legend><div className="mt-2 flex flex-wrap gap-2">{LENGTHS.map((option) => <button key={option.value} type="button" aria-pressed={configuration.length === option.value} onClick={() => setConfiguration((current) => ({ ...current, length: option.value }))} className={`rounded-full border px-3 py-2 text-xs font-semibold ${configuration.length === option.value ? "border-neutral-950 bg-neutral-950 text-white" : "border-neutral-300 text-neutral-700"}`}>{option.label}</button>)}</div><p className="mt-2 text-xs text-neutral-500" aria-live="polite">{LENGTH_HINTS[configuration.length]}</p></fieldset>
            <fieldset><legend className="text-sm font-semibold text-neutral-900">2. Shape / Dáng móng</legend><div className="mt-2 flex flex-wrap gap-2">{SHAPES.map((option) => <button key={option.value} type="button" aria-pressed={configuration.shape === option.value} onClick={() => setConfiguration((current) => ({ ...current, shape: option.value }))} className={`rounded-full border px-3 py-2 text-xs font-semibold ${configuration.shape === option.value ? "border-neutral-950 bg-neutral-950 text-white" : "border-neutral-300 text-neutral-700"}`}>{option.label}</button>)}</div></fieldset>
            <fieldset><legend className="text-sm font-semibold text-neutral-900">3. Color / Màu</legend><div className="mt-2 grid grid-cols-4 gap-2">{COLORS.map((option) => <button key={option.value} type="button" aria-pressed={configuration.color === option.value} onClick={() => setConfiguration((current) => ({ ...current, color: option.value }))} className={`rounded-2xl border p-2 text-center text-[11px] font-semibold ${configuration.color === option.value ? "border-neutral-950 ring-2 ring-neutral-950/20" : "border-neutral-200"}`}><span className="mx-auto block h-8 w-8 rounded-full border border-black/10" style={{ background: option.swatch }} /><span className="mt-1 block">{option.label}</span></button>)}</div></fieldset>
            <fieldset><legend className="text-sm font-semibold text-neutral-900">4. Style / Kiểu sơn</legend><div className="mt-2 flex flex-wrap gap-2">{ART_STYLES.map((option) => <button key={option.value} type="button" aria-pressed={configuration.artStyle === option.value} onClick={() => setConfiguration((current) => ({ ...current, artStyle: option.value }))} className={`rounded-full border px-3 py-2 text-xs font-semibold ${configuration.artStyle === option.value ? "border-neutral-950 bg-neutral-950 text-white" : "border-neutral-300 text-neutral-700"}`}>{option.label}</button>)}</div></fieldset>
            <fieldset><legend className="text-sm font-semibold text-neutral-900">5. Finish / Hiệu ứng</legend><div className="mt-2 flex flex-wrap gap-2">{FINISHES.map((option) => <button key={option.value} type="button" aria-pressed={configuration.finish === option.value} onClick={() => setConfiguration((current) => ({ ...current, finish: option.value }))} className={`rounded-full border px-3 py-2 text-xs font-semibold ${configuration.finish === option.value ? "border-neutral-950 bg-neutral-950 text-white" : "border-neutral-300 text-neutral-700"}`}>{option.label}</button>)}</div></fieldset>
          </div>
          <h3 className="mt-6 text-sm font-semibold text-neutral-900">6. Decoration / Mẫu trang trí</h3>
          {designs.length ? <div className="mt-5 grid grid-cols-2 gap-3">{designs.map((design) => (
            <button key={design.id} type="button" disabled={busy} onClick={() => void generate(design.id)} className="overflow-hidden rounded-2xl border border-neutral-200 text-left transition hover:border-neutral-500 disabled:opacity-60">
              {design.previewUrl ? <img src={design.previewUrl} alt={design.name} className="aspect-square w-full object-cover" /> : <div className="aspect-square bg-neutral-100" />}
              <span className="block p-3 text-sm font-semibold text-neutral-900">{design.name}</span>
            </button>
          ))}</div> : <p className="mt-5 rounded-2xl bg-neutral-50 p-4 text-sm text-neutral-600">This salon has not published try-on designs yet.</p>}
          {busy ? <p className="mt-4 rounded-2xl bg-blue-50 p-4 text-sm text-blue-900" role="status">{generationSeconds < 20 ? "Preparing your nail preview… / Đang chuẩn bị ảnh…" : generationSeconds < 50 ? "Applying the design to your nails… / Đang thử mẫu lên móng…" : "Adding the final details—please keep this page open. / Đang hoàn thiện, vui lòng giữ trang này mở."}</p> : null}
          {serverMessage ? <p className="mt-4 text-sm text-red-700" role="alert">{serverMessage}</p> : null}
        </section>
      ) : step === "result" ? (
        <section className="overflow-hidden rounded-3xl border border-neutral-200 bg-white shadow-xl shadow-black/5">
          <div className="relative bg-neutral-100">
            {resultUrl ? <img src={resultUrl} alt="AI nail preview on your hand" className="aspect-square w-full object-contain" /> : previewUrl ? <img src={previewUrl} alt="Your hand while AI preview is prepared" className="aspect-square w-full object-contain" /> : <div className="aspect-square" />}
            {!resultUrl && selectedDesign?.previewUrl ? <div className="absolute bottom-4 right-4 w-24 overflow-hidden rounded-2xl border-4 border-white bg-white shadow-xl"><img src={selectedDesign.previewUrl} alt={`Selected design: ${selectedDesign.name}`} className="aspect-square w-full object-cover" /><p className="truncate px-2 py-1 text-center text-[10px] font-semibold text-neutral-800">{selectedDesign.name}</p></div> : null}
          </div>
          <div className="p-5 sm:p-7">
            {resultUrl ? <><p className="text-xs font-semibold uppercase tracking-widest text-emerald-700">AI preview ready</p><h2 className="mt-2 text-2xl font-semibold text-neutral-950">See yourself in this look</h2><p className="mt-2 text-sm text-neutral-600">AI preview—actual color and result may vary.</p><a href={`/${salonSlug}?tryon=${encodeURIComponent(sessionId || "")}`} className="mt-5 flex min-h-12 items-center justify-center rounded-full bg-neutral-950 px-5 font-semibold text-white">Continue to booking</a></> : <><p className="text-xs font-semibold uppercase tracking-widest text-blue-700">Design selected instantly</p><h2 className="mt-2 text-2xl font-semibold text-neutral-950">{selectedDesign?.name || "Preparing your look"}</h2>{busy ? <p className="mt-3 rounded-2xl bg-blue-50 p-4 text-sm text-blue-900" role="status">{generationSeconds < 20 ? "Preparing your nail preview… / Đang chuẩn bị ảnh…" : generationSeconds < 50 ? "Applying the design to your nails… / Đang thử mẫu lên móng…" : "Adding the final details—please keep this page open. / Đang hoàn thiện, vui lòng giữ trang này mở."}</p> : null}{serverMessage ? <p className="mt-3 rounded-2xl bg-red-50 p-4 text-sm text-red-800" role="alert">{serverMessage}</p> : null}{!busy ? <button type="button" onClick={() => { setServerMessage(null); setStep("catalog"); }} className="mt-4 min-h-12 w-full rounded-full border border-neutral-300 px-5 font-semibold text-neutral-800">Choose another design / Chọn mẫu khác</button> : null}</>}
          </div>
        </section>
      ) : !consented ? (
        <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-xl shadow-black/5">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700"><ShieldCheck aria-hidden /></div>
          <h2 className="mt-5 text-xl font-semibold text-neutral-950">Your photo stays private</h2>
          <p className="mt-2 text-sm leading-6 text-neutral-600">NailIQ processes this hand photo only to create your AI preview. Unused photos are deleted after 24 hours. After upload, you can delete yours immediately.</p>
          <label className="mt-5 flex cursor-pointer gap-3 rounded-2xl bg-neutral-50 p-4 text-sm text-neutral-700">
            <input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} className="mt-0.5 h-5 w-5 accent-black" />
            <span>I agree to this photo processing. I understand the AI preview may differ from the real result.</span>
          </label>
        </section>
      ) : (
        <section className="overflow-hidden rounded-3xl border border-neutral-200 bg-white shadow-xl shadow-black/5">
          {!previewUrl ? (
            <div className="p-5 sm:p-7">
              <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-3xl bg-neutral-950 text-white">
                <div className="absolute inset-7 rounded-[40%] border-2 border-dashed border-white/50" />
                <div className="relative text-center">
                  <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full border border-white/20 bg-white/10"><Camera className="h-9 w-9" aria-hidden /></div>
                  <p className="mt-4 text-sm font-medium">Place one hand inside the guide</p>
                </div>
              </div>
              <ul className="mt-5 grid grid-cols-2 gap-2 text-xs text-neutral-600">
                {["Palm down", "Five nails visible", "Soft, even light", "No motion blur"].map((item) => <li key={item} className="flex items-center gap-2"><Check className="h-4 w-4 text-emerald-600" aria-hidden />{item}</li>)}
              </ul>
              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => cameraInputRef.current?.click()}
                  className="flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-neutral-950 px-5 font-semibold text-white"
                >
                  <Camera className="h-5 w-5" aria-hidden />
                  Take photo / Chụp ảnh
                </button>
                <button
                  type="button"
                  onClick={() => libraryInputRef.current?.click()}
                  className="flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-neutral-300 bg-white px-5 font-semibold text-neutral-900"
                >
                  <ImagePlus className="h-5 w-5" aria-hidden />
                  Choose photo / Chọn ảnh
                </button>
              </div>
              <p className="mt-3 text-center text-xs leading-5 text-neutral-500">
                On a phone, “Take photo” opens the rear camera. If camera access
                is unavailable, choose an existing photo instead.
              </p>
            </div>
          ) : (
            <div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl} alt="Your hand photo preview" className="aspect-[4/3] w-full bg-neutral-100 object-contain" />
              <div className="p-5 sm:p-7">
                <p className="truncate text-xs text-neutral-400">{fileName}</p>
                {quality === "checking" ? <p className="mt-2 font-medium text-neutral-700" role="status">Checking light and sharpness…</p> : null}
                {quality === "pass" ? (
                  <div className="mt-2 rounded-2xl bg-emerald-50 p-4 text-emerald-900" role="status"><p className="font-semibold">Photo looks ready</p><p className="mt-1 text-sm">Next, NailIQ will verify that exactly one hand and five nails are visible.</p></div>
                ) : null}
                {quality && quality !== "checking" && quality !== "pass" ? (
                  <div className="mt-2 rounded-2xl bg-amber-50 p-4 text-amber-950" role="alert"><p className="font-semibold">{BLOCKING_CLIENT_CODES.has(quality) ? "Please choose another photo / Hãy chọn ảnh khác" : "Photo quality warning / Cảnh báo chất lượng ảnh"}</p><p className="mt-1 text-sm">{COPY[quality]}</p></div>
                ) : null}
                <button type="button" onClick={reset} className="mt-5 flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-neutral-300 px-5 font-semibold text-neutral-800"><RotateCcw className="h-4 w-4" aria-hidden />Retake</button>
                {serverMessage ? <p className="mt-3 rounded-2xl bg-red-50 p-4 text-sm text-red-800" role="alert">{serverMessage}</p> : null}
                {serverWarning ? <p className="mt-3 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900" role="status">{serverWarning}</p> : null}
                {quality && quality !== "checking" && !BLOCKING_CLIENT_CODES.has(quality) ? <button type="button" disabled={busy} onClick={() => void uploadAndVerify()} className="mt-3 min-h-12 w-full rounded-full bg-neutral-950 px-5 font-semibold text-white disabled:bg-neutral-300 disabled:text-neutral-600">{busy ? "Verifying hand and nails…" : quality === "pass" ? "Continue to designs" : "Continue anyway / Vẫn tiếp tục"}</button> : null}
              </div>
            </div>
          )}
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            aria-label="Take a hand photo with the rear camera"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void inspect(file);
            }}
          />
          <input
            ref={libraryInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            aria-label="Choose an existing hand photo"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void inspect(file);
            }}
          />
        </section>
      )}

      {deletionMessage ? (
        <p className="mt-5 rounded-2xl bg-emerald-50 p-4 text-sm font-medium text-emerald-900" role="status">
          {deletionMessage}
        </p>
      ) : null}

      {sessionId ? (
        <section className="mt-5 rounded-2xl border border-neutral-200 bg-white p-4">
          {!deleteConfirmOpen ? (
            <button
              type="button"
              disabled={busy || deleting}
              onClick={() => setDeleteConfirmOpen(true)}
              className="min-h-11 w-full rounded-full border border-red-200 px-4 text-sm font-semibold text-red-700 disabled:opacity-50"
            >
              Delete my photo now / Xóa ảnh của tôi ngay
            </button>
          ) : (
            <div role="alert">
              <p className="text-sm font-semibold text-neutral-950">Permanently delete this photo?</p>
              <p className="mt-1 text-xs leading-5 text-neutral-600">The hand photo and AI preview cannot be recovered. / Ảnh bàn tay và ảnh AI sẽ không thể khôi phục.</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => setDeleteConfirmOpen(false)}
                  className="min-h-11 rounded-full border border-neutral-300 px-3 text-sm font-semibold text-neutral-800 disabled:opacity-50"
                >
                  Cancel / Hủy
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => void deleteUploadedPhoto()}
                  className="min-h-11 rounded-full bg-red-700 px-3 text-sm font-semibold text-white disabled:bg-red-300"
                >
                  {deleting ? "Deleting… / Đang xóa…" : "Delete permanently / Xóa vĩnh viễn"}
                </button>
              </div>
            </div>
          )}
        </section>
      ) : null}

      <a href={`/${salonSlug}`} className="mx-auto mt-6 block w-fit text-sm font-medium text-neutral-600 underline-offset-4 hover:underline">Back to booking</a>
    </div>
  );
}
