"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Check, ImagePlus, RotateCcw, ShieldCheck } from "lucide-react";
import {
  evaluateClientImageQuality,
  inspectPixels,
  type ClientQualityCode,
} from "@/shared/nailTryOn/imageQuality";

const COPY: Record<Exclude<ClientQualityCode, "pass">, string> = {
  unsupported_format: "Use a JPEG, PNG, or WebP image.",
  file_too_large: "This photo is over 10 MB. Choose a smaller image.",
  resolution_too_low: "Move closer and retake—the hand needs more detail.",
  resolution_too_high: "This image is too large to process safely. Choose a smaller photo.",
  too_dark: "Add soft light so every nail is clearly visible.",
  too_bright: "Reduce glare or direct flash, then retake.",
  blurred: "Hold still and tap to focus before retaking.",
};

type Props = {
  salonName: string;
  salonSlug: string;
  brandColor: string;
};

type CatalogDesign = { id: string; name: string; description: string | null; previewUrl: string | null };

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
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  async function inspect(file: File) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    setFileName(file.name || "hand-photo");
    setPhoto(file);
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
    if (inputRef.current) inputRef.current.value = "";
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
      const response = await fetch("/api/nail-tryon/upload", { method: "POST", body: form });
      const payload = await response.json() as { sessionId?: string; quality?: string; reason?: string; error?: string };
      if (!response.ok || !payload.sessionId || payload.quality !== "pass") {
        setServerMessage(payload.reason || "We could not verify five visible nails. Retake with one hand, palm down.");
        return;
      }
      setSessionId(payload.sessionId);
      const catalogResponse = await fetch(`/api/nail-tryon/catalog?slug=${encodeURIComponent(salonSlug)}`);
      const catalog = await catalogResponse.json() as { designs?: CatalogDesign[] };
      setDesigns(catalog.designs || []);
      setStep("catalog");
    } catch {
      setServerMessage("Photo verification is temporarily unavailable. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function generate(designId: string) {
    if (!sessionId) return;
    setBusy(true);
    setServerMessage(null);
    try {
      const response = await fetch("/api/nail-tryon/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, designId }),
      });
      const payload = await response.json() as { previewUrl?: string; error?: string };
      if (!response.ok || !payload.previewUrl) throw new Error(payload.error || "generation_failed");
      setResultUrl(payload.previewUrl);
      setStep("result");
    } catch {
      setServerMessage("The AI preview could not be created. Your booking is still available—please try again.");
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
          <h2 className="mt-2 text-2xl font-semibold text-neutral-950">Choose a salon design</h2>
          {designs.length ? <div className="mt-5 grid grid-cols-2 gap-3">{designs.map((design) => (
            <button key={design.id} type="button" disabled={busy} onClick={() => void generate(design.id)} className="overflow-hidden rounded-2xl border border-neutral-200 text-left transition hover:border-neutral-500 disabled:opacity-60">
              {design.previewUrl ? <img src={design.previewUrl} alt={design.name} className="aspect-square w-full object-cover" /> : <div className="aspect-square bg-neutral-100" />}
              <span className="block p-3 text-sm font-semibold text-neutral-900">{design.name}</span>
            </button>
          ))}</div> : <p className="mt-5 rounded-2xl bg-neutral-50 p-4 text-sm text-neutral-600">This salon has not published try-on designs yet.</p>}
          {busy ? <p className="mt-4 text-sm text-neutral-600" role="status">Creating your private AI preview…</p> : null}
          {serverMessage ? <p className="mt-4 text-sm text-red-700" role="alert">{serverMessage}</p> : null}
        </section>
      ) : step === "result" && resultUrl ? (
        <section className="overflow-hidden rounded-3xl border border-neutral-200 bg-white shadow-xl shadow-black/5">
          <img src={resultUrl} alt="AI nail preview on your hand" className="aspect-square w-full object-contain" />
          <div className="p-5 sm:p-7"><p className="text-xs font-semibold uppercase tracking-widest text-emerald-700">AI preview ready</p><h2 className="mt-2 text-2xl font-semibold text-neutral-950">See yourself in this look</h2><p className="mt-2 text-sm text-neutral-600">AI preview—actual color and result may vary.</p><a href={`/${salonSlug}`} className="mt-5 flex min-h-12 items-center justify-center rounded-full bg-neutral-950 px-5 font-semibold text-white">Continue to booking</a></div>
        </section>
      ) : !consented ? (
        <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-xl shadow-black/5">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700"><ShieldCheck aria-hidden /></div>
          <h2 className="mt-5 text-xl font-semibold text-neutral-950">Your photo stays private</h2>
          <p className="mt-2 text-sm leading-6 text-neutral-600">NailIQ processes this hand photo only to create your AI preview. An unused photo expires after 24 hours. You can delete it sooner.</p>
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
              <button type="button" onClick={() => inputRef.current?.click()} className="mt-6 flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-neutral-950 px-5 font-semibold text-white"><ImagePlus className="h-5 w-5" aria-hidden />Take or choose photo</button>
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
                  <div className="mt-2 rounded-2xl bg-amber-50 p-4 text-amber-950" role="alert"><p className="font-semibold">Please retake this photo</p><p className="mt-1 text-sm">{COPY[quality]}</p></div>
                ) : null}
                <button type="button" onClick={reset} className="mt-5 flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-neutral-300 px-5 font-semibold text-neutral-800"><RotateCcw className="h-4 w-4" aria-hidden />Retake</button>
                {serverMessage ? <p className="mt-3 rounded-2xl bg-red-50 p-4 text-sm text-red-800" role="alert">{serverMessage}</p> : null}
                {quality === "pass" ? <button type="button" disabled={busy} onClick={() => void uploadAndVerify()} className="mt-3 min-h-12 w-full rounded-full bg-neutral-950 px-5 font-semibold text-white disabled:bg-neutral-300 disabled:text-neutral-600">{busy ? "Verifying hand and nails…" : "Continue to designs"}</button> : null}
              </div>
            </div>
          )}
          <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void inspect(file); }} />
        </section>
      )}

      <a href={`/${salonSlug}`} className="mx-auto mt-6 block w-fit text-sm font-medium text-neutral-600 underline-offset-4 hover:underline">Back to booking</a>
    </div>
  );
}
