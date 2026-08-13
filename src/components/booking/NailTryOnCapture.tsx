"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Check, ImagePlus, RotateCcw, ShieldCheck, Sparkles, X } from "lucide-react";
import {
  evaluateClientImageQuality,
  inspectPixels,
  type ClientQualityCode,
} from "@/shared/nailTryOn/imageQuality";
import {
  cameraStartMessage,
  REAR_CAMERA_CONSTRAINTS,
  stopMediaStream,
} from "@/shared/nailTryOn/camera";
import { DEFAULT_NAIL_CONFIGURATION, type NailConfiguration } from "@/shared/nailTryOn/configurator";
import {
  fetchNailTryOn,
  NAIL_TRYON_CATALOG_CLIENT_TIMEOUT_MS,
  NAIL_TRYON_GENERATION_CLIENT_TIMEOUT_MS,
  NAIL_TRYON_UPLOAD_CLIENT_TIMEOUT_MS,
  NailTryOnRequestTimeoutError,
} from "@/shared/nailTryOn/timeouts";
import type { NailTryOnCaptureMode } from "@/shared/nailTryOn/captureMode";

const COPY: Record<Exclude<ClientQualityCode, "pass">, { en: string; vi: string }> = {
  unsupported_format: { en: "Use a JPEG, PNG, or WebP image.", vi: "Hãy dùng ảnh JPEG, PNG hoặc WebP." },
  file_too_large: { en: "This photo is over 10 MB.", vi: "Ảnh lớn hơn 10 MB." },
  resolution_too_low: { en: "This image is too small. Use the original photo or camera.", vi: "Ảnh này có độ phân giải quá thấp. Hãy dùng ảnh gốc hoặc camera." },
  resolution_suboptimal: { en: "This image is smaller than ideal, but you can still continue.", vi: "Ảnh hơi nhỏ nhưng bạn vẫn có thể tiếp tục." },
  resolution_too_high: { en: "Choose a smaller image.", vi: "Hãy chọn ảnh có kích thước nhỏ hơn." },
  too_dark: { en: "The preview may be less accurate in low light.", vi: "Ảnh tối có thể làm kết quả kém chính xác." },
  too_bright: { en: "Glare may reduce preview accuracy.", vi: "Ánh sáng chói có thể làm kết quả kém chính xác." },
  blurred: { en: "This photo looks a little soft, but you may continue.", vi: "Ảnh hơi mờ nhưng bạn vẫn có thể tiếp tục." },
};

const BLOCKING_CLIENT_CODES = new Set<ClientQualityCode>([
  "unsupported_format", "file_too_large", "resolution_too_low", "resolution_too_high",
]);

type Props = {
  salonName: string;
  salonSlug: string;
  brandColor: string;
  language: "en" | "vi";
};

type CatalogDesign = { id: string; name: string; description: string | null; previewUrl: string | null };
type CameraState = "idle" | "starting" | "live" | "fallback";
type CaptureStage = "single" | "four" | "thumb";
type HandSide = "left" | "right";
type CoachStatus = "idle" | "positioning" | "too_dark" | "too_bright" | "soft" | "hold_still" | "countdown" | "capturing";

function drawCoverImage(
  context: CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const scale = Math.max(width / bitmap.width, height / bitmap.height);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  const sourceX = (bitmap.width - sourceWidth) / 2;
  const sourceY = (bitmap.height - sourceHeight) / 2;
  context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

async function composeFourPlusOneCapture(fourFingers: File, thumb: File) {
  const [fourBitmap, thumbBitmap] = await Promise.all([
    createImageBitmap(fourFingers, { imageOrientation: "from-image" }),
    createImageBitmap(thumb, { imageOrientation: "from-image" }),
  ]);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 1200;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas_unavailable");

    context.fillStyle = "#f5f5f4";
    context.fillRect(0, 0, canvas.width, canvas.height);
    drawCoverImage(context, fourBitmap, 0, 0, 1180, 1200);
    context.fillStyle = "#d4af37";
    context.fillRect(1180, 0, 16, 1200);
    drawCoverImage(context, thumbBitmap, 1196, 0, 404, 1200);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) throw new Error("capture_board_failed");
    return new File([blob], `nail-tryon-4-plus-1-${Date.now()}.jpg`, { type: "image/jpeg" });
  } finally {
    fourBitmap.close();
    thumbBitmap.close();
  }
}

function SmartHandGuide({
  handSide,
  stage,
  active,
}: {
  handSide: HandSide;
  stage: CaptureStage;
  active: boolean;
}) {
  const isThumbOnly = stage === "thumb";
  const showThumb = stage !== "four";
  const stroke = active ? "#34d399" : "rgba(255,255,255,0.82)";
  return (
    <svg
      viewBox="0 0 120 90"
      aria-hidden
      className={`pointer-events-none absolute inset-4 h-[calc(100%-2rem)] w-[calc(100%-2rem)] transition-transform ${handSide === "left" ? "-scale-x-100" : ""}`}
    >
      {isThumbOnly ? (
        <>
          <path d="M42 73 C34 55 38 27 52 14 C62 6 78 12 78 25 L77 63 C76 76 52 82 42 73Z" fill="rgba(255,255,255,0.06)" stroke={stroke} strokeWidth="2" strokeDasharray="4 3" />
          <ellipse cx="64" cy="23" rx="9" ry="13" fill="none" stroke={stroke} strokeWidth="2.4" />
        </>
      ) : (
        <>
          <path d="M31 76 C25 63 24 47 28 36 L31 17 C32 10 43 10 44 18 L45 31 L48 11 C49 3 61 4 61 12 L61 31 L66 10 C68 3 79 5 79 13 L76 34 L83 17 C86 10 96 14 94 22 L88 45 C93 39 101 35 107 39 C112 43 108 50 103 54 L87 73 C78 84 39 86 31 76Z" fill="rgba(255,255,255,0.06)" stroke={stroke} strokeWidth="2" strokeDasharray="4 3" />
          <ellipse cx="38" cy="19" rx="5" ry="8" fill="none" stroke={stroke} strokeWidth="2" />
          <ellipse cx="55" cy="13" rx="5" ry="8" fill="none" stroke={stroke} strokeWidth="2" />
          <ellipse cx="72" cy="14" rx="5" ry="8" fill="none" stroke={stroke} strokeWidth="2" />
          <ellipse cx="88" cy="22" rx="5" ry="8" fill="none" stroke={stroke} strokeWidth="2" />
          {showThumb ? <ellipse cx="102" cy="46" rx="8" ry="5" fill="none" stroke={stroke} strokeWidth="2" /> : null}
        </>
      )}
    </svg>
  );
}
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
export function NailTryOnCapture({ salonName, salonSlug, brandColor, language }: Props) {
  const vi = language === "vi";
  const L = (en: string, viText: string) => (vi ? viText : en);
  const localizedPair = (copy: string) => {
    const [en, viText] = copy.split(" / ");
    return vi ? (viText || en) : en;
  };
  const [consented, setConsented] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [quality, setQuality] = useState<ClientQualityCode | "checking" | null>(null);
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
  const [cameraState, setCameraState] = useState<CameraState>("idle");
  const [cameraMessage, setCameraMessage] = useState<string | null>(null);
  const [supportsDirectCapture, setSupportsDirectCapture] = useState(false);
  const [captureMode, setCaptureMode] = useState<NailTryOnCaptureMode>("single");
  const [captureStage, setCaptureStage] = useState<CaptureStage>("single");
  const [handSide, setHandSide] = useState<HandSide>("right");
  const [fourFingerPhoto, setFourFingerPhoto] = useState<File | null>(null);
  const [fourFingerPreviewUrl, setFourFingerPreviewUrl] = useState<string | null>(null);
  const [coachStatus, setCoachStatus] = useState<CoachStatus>("idle");
  const [coachCountdown, setCoachCountdown] = useState<number | null>(null);
  const [coachRunning, setCoachRunning] = useState(false);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraRequestRef = useRef(0);
  const coachIntervalRef = useRef<number | null>(null);
  const coachPreviousFrameRef = useRef<Uint8ClampedArray | null>(null);
  const coachStableFramesRef = useRef(0);
  const coachCaptureLockRef = useRef(false);

  const stopCamera = useCallback(() => {
    cameraRequestRef.current += 1;
    if (coachIntervalRef.current !== null) window.clearInterval(coachIntervalRef.current);
    coachIntervalRef.current = null;
    coachPreviousFrameRef.current = null;
    coachStableFramesRef.current = 0;
    coachCaptureLockRef.current = false;
    stopMediaStream(cameraStreamRef.current);
    cameraStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCoachStatus("idle");
    setCoachCountdown(null);
    setCoachRunning(false);
  }, []);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  useEffect(() => () => {
    if (fourFingerPreviewUrl) URL.revokeObjectURL(fourFingerPreviewUrl);
  }, [fourFingerPreviewUrl]);

  useEffect(() => {
    window.addEventListener("pagehide", stopCamera);
    return () => {
      window.removeEventListener("pagehide", stopCamera);
      stopCamera();
    };
  }, [stopCamera]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const mobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
        || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      setSupportsDirectCapture(mobileDevice);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!busy || step !== "result") return;
    const timer = window.setInterval(() => setGenerationSeconds((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [busy, step]);

  async function inspect(file: File) {
    stopCamera();
    setCameraState("idle");
    setCameraMessage(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
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

  function clearFourPlusOneDraft() {
    if (fourFingerPreviewUrl) URL.revokeObjectURL(fourFingerPreviewUrl);
    setFourFingerPhoto(null);
    setFourFingerPreviewUrl(null);
  }

  function reset(nextMode: NailTryOnCaptureMode = captureMode) {
    stopCamera();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    clearFourPlusOneDraft();
    setPreviewUrl(null);
    setQuality(null);
    setPhoto(null);
    setServerMessage(null);
    setServerWarning(null);
    setCameraState("idle");
    setCameraMessage(null);
    setCaptureStage(nextMode === "four_plus_one" ? "four" : "single");
    if (cameraInputRef.current) cameraInputRef.current.value = "";
    if (libraryInputRef.current) libraryInputRef.current.value = "";
  }

  function chooseCaptureMode(nextMode: NailTryOnCaptureMode) {
    if (nextMode === captureMode && !previewUrl && !fourFingerPhoto) return;
    reset(nextMode);
    setCaptureMode(nextMode);
  }

  async function startLiveCamera() {
    stopCamera();
    setCameraMessage(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState("fallback");
      setCameraMessage("Live camera is not available here. Use your device camera or choose a photo. / Không thể mở camera trực tiếp tại đây. Hãy dùng camera thiết bị hoặc chọn ảnh.");
      return;
    }

    const requestId = cameraRequestRef.current;
    setCameraState("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia(REAR_CAMERA_CONSTRAINTS);
      if (requestId !== cameraRequestRef.current) {
        stopMediaStream(stream);
        return;
      }

      cameraStreamRef.current = stream;
      if (!videoRef.current) throw new Error("camera_preview_unavailable");
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCameraState("live");
      setCoachStatus("positioning");
    } catch (error) {
      stopCamera();
      setCameraState("fallback");
      setCameraMessage(cameraStartMessage(error));
    }
  }

  async function captureLivePhoto() {
    const video = videoRef.current;
    if (!video || video.videoWidth < 1 || video.videoHeight < 1) {
      setCameraMessage("The camera is still starting. Please wait a moment and try again. / Camera đang khởi động. Vui lòng chờ một chút rồi thử lại.");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      setCameraMessage("We could not capture this frame. Please choose a photo instead. / Chưa thể chụp ảnh này. Vui lòng chọn ảnh có sẵn.");
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) {
      setCameraMessage("We could not capture this frame. Please choose a photo instead. / Chưa thể chụp ảnh này. Vui lòng chọn ảnh có sẵn.");
      return;
    }

    const file = new File([blob], `nail-tryon-${Date.now()}.jpg`, { type: "image/jpeg" });
    await acceptCapturedPhoto(file);
  }

  async function acceptCapturedPhoto(file: File) {
    if (captureMode !== "four_plus_one") {
      await inspect(file);
      return;
    }

    if (captureStage === "four") {
      stopCamera();
      clearFourPlusOneDraft();
      const url = URL.createObjectURL(file);
      setFourFingerPhoto(file);
      setFourFingerPreviewUrl(url);
      setCaptureStage("thumb");
      setCameraState("idle");
      setCameraMessage(L("Four fingers saved. Now capture the thumb.", "Đã lưu 4 ngón. Bây giờ chụp riêng ngón cái."));
      return;
    }

    if (!fourFingerPhoto) {
      setCaptureStage("four");
      setCameraMessage(L("Capture four fingers first.", "Hãy chụp 4 ngón trước."));
      return;
    }

    try {
      setCameraMessage(L("Combining both views…", "Đang ghép hai góc chụp…"));
      const captureBoard = await composeFourPlusOneCapture(fourFingerPhoto, file);
      await inspect(captureBoard);
      clearFourPlusOneDraft();
    } catch {
      setCameraMessage(L("We could not combine these photos. Please retake them.", "Chưa thể ghép hai ảnh. Vui lòng chụp lại."));
    }
  }

  function stopAutoCoach() {
    if (coachIntervalRef.current !== null) window.clearInterval(coachIntervalRef.current);
    coachIntervalRef.current = null;
    coachPreviousFrameRef.current = null;
    coachStableFramesRef.current = 0;
    setCoachCountdown(null);
    setCoachStatus("positioning");
    setCoachRunning(false);
  }

  function startAutoCoach() {
    const video = videoRef.current;
    if (!video || cameraState !== "live" || coachIntervalRef.current !== null) return;
    coachStableFramesRef.current = 0;
    coachCaptureLockRef.current = false;
    coachPreviousFrameRef.current = null;
    setCoachStatus("positioning");
    setCoachCountdown(null);
    setCoachRunning(true);

    coachIntervalRef.current = window.setInterval(() => {
      const currentVideo = videoRef.current;
      if (!currentVideo || currentVideo.videoWidth < 1 || currentVideo.videoHeight < 1 || coachCaptureLockRef.current) return;
      const canvas = document.createElement("canvas");
      canvas.width = 96;
      canvas.height = 72;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      context.drawImage(currentVideo, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const stats = inspectPixels(pixels.data, canvas.width, canvas.height);

      let nextStatus: CoachStatus = "countdown";
      if (stats.meanLuma < 48) nextStatus = "too_dark";
      else if (stats.meanLuma > 235) nextStatus = "too_bright";
      else if (stats.edgeVariance < 5.5) nextStatus = "soft";

      const previous = coachPreviousFrameRef.current;
      let motion = 0;
      if (previous?.length === pixels.data.length) {
        let samples = 0;
        for (let offset = 0; offset < pixels.data.length; offset += 32) {
          motion += Math.abs(pixels.data[offset] - previous[offset]);
          samples += 1;
        }
        motion /= Math.max(1, samples);
      }
      coachPreviousFrameRef.current = new Uint8ClampedArray(pixels.data);

      if (nextStatus === "countdown" && previous && motion > 12) nextStatus = "hold_still";
      if (nextStatus !== "countdown") {
        coachStableFramesRef.current = 0;
        setCoachCountdown(null);
        setCoachStatus(nextStatus);
        return;
      }

      coachStableFramesRef.current += 1;
      const remaining = Math.max(1, 4 - coachStableFramesRef.current);
      setCoachStatus("countdown");
      setCoachCountdown(remaining);
      if (coachStableFramesRef.current < 4) return;

      coachCaptureLockRef.current = true;
      if (coachIntervalRef.current !== null) window.clearInterval(coachIntervalRef.current);
      coachIntervalRef.current = null;
      setCoachCountdown(null);
      setCoachStatus("capturing");
      setCoachRunning(false);
      void captureLivePhoto();
    }, 450);
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
      setPhoto(null);
      setSessionId(null);
      setDesigns([]);
      setStep("capture");
      setResultUrl(null);
      setSelectedDesign(null);
      setServerWarning(null);
      setConsented(false);
      setConsentChecked(false);
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
    form.set("capture_mode", captureMode);
    try {
      const response = await fetchNailTryOn(
        "/api/nail-tryon/upload",
        { method: "POST", body: form },
        NAIL_TRYON_UPLOAD_CLIENT_TIMEOUT_MS,
      );
      const payload = await response.json() as { sessionId?: string; quality?: string; warning?: boolean; reason?: string; error?: string };
      if (!response.ok || !payload.sessionId || payload.quality !== "pass") {
        setServerMessage(captureMode === "four_plus_one"
          ? L("We could not verify four nails plus the thumbnail. Please retake both views.", "Chưa thấy rõ 4 móng và ngón cái. Vui lòng chụp lại hai góc.")
          : L("We could not verify five visible nails. Retake with one hand, palm down.", "Chưa thấy rõ đủ 5 móng. Vui lòng úp tay và chụp lại."));
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

  const capturePrompt = captureStage === "thumb"
    ? L("Place only the thumbnail inside the guide", "Đặt riêng móng cái vào khung")
    : captureStage === "four"
      ? L("Keep four fingers together inside the guide", "Đặt 4 ngón ngay ngắn trong khung")
      : L("Fan the fingers and angle the thumb outward", "Xòe nhẹ 4 ngón và đưa ngón cái ra ngoài");
  const coachMessage = coachStatus === "too_dark"
    ? L("More light, please", "Cần thêm ánh sáng")
    : coachStatus === "too_bright"
      ? L("Move away from glare", "Tránh vùng ánh sáng chói")
      : coachStatus === "soft"
        ? L("Move closer and focus", "Đưa tay gần hơn và lấy nét")
        : coachStatus === "hold_still"
          ? L("Hold still…", "Giữ yên…")
          : coachStatus === "countdown" && coachCountdown
            ? L(`Ready · ${coachCountdown}`, `Sẵn sàng · ${coachCountdown}`)
            : coachStatus === "capturing"
              ? L("Capturing…", "Đang chụp…")
              : capturePrompt;
  return (
    <div className="mx-auto w-full max-w-lg">
      <div className="mb-8 text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-black/10 bg-white px-3 py-1 text-xs font-semibold text-neutral-700 shadow-sm">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: brandColor }} />
          {salonName}
        </span>
        <p className="mt-5 text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">
          {step === "capture" ? L("Step 1 of 3", "Bước 1/3") : step === "catalog" ? L("Step 2 of 3", "Bước 2/3") : L("Step 3 of 3", "Bước 3/3")}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-neutral-950">{L("Try on nails", "Thử mẫu nail")}</h1>
        <p className="mt-2 text-sm leading-6 text-neutral-600">
          {captureMode === "four_plus_one"
            ? L("Capture four fingers, then the thumb. NailIQ combines both views.", "Chụp 4 ngón trước, rồi ngón cái. NailIQ sẽ tự ghép hai góc.")
            : L("Smart guidance helps you show all five nails.", "Hướng dẫn thông minh giúp bạn chụp rõ đủ 5 móng.")}
        </p>
      </div>

      {step === "catalog" ? (
        <section className="rounded-3xl border border-neutral-200 bg-white p-5 shadow-xl shadow-black/5 sm:p-7">
          <h2 className="text-2xl font-semibold text-neutral-950">{L("Build your nail look", "Tạo mẫu nail của bạn")}</h2>
          {serverWarning ? <p className="mt-4 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900" role="status">{serverWarning}</p> : null}
          <div className="mt-5 space-y-5">
            <fieldset><legend className="text-sm font-semibold text-neutral-900">1. {L("Length", "Độ dài")}</legend><div className="mt-2 flex flex-wrap gap-2">{LENGTHS.map((option) => <button key={option.value} type="button" aria-pressed={configuration.length === option.value} onClick={() => setConfiguration((current) => ({ ...current, length: option.value }))} className={`rounded-full border px-3 py-2 text-xs font-semibold ${configuration.length === option.value ? "border-neutral-950 bg-neutral-950 text-white" : "border-neutral-300 text-neutral-700"}`}>{option.label}</button>)}</div><p className="mt-2 text-xs text-neutral-500" aria-live="polite">{localizedPair(LENGTH_HINTS[configuration.length])}</p></fieldset>
            <fieldset><legend className="text-sm font-semibold text-neutral-900">2. {L("Shape", "Dáng móng")}</legend><div className="mt-2 flex flex-wrap gap-2">{SHAPES.map((option) => <button key={option.value} type="button" aria-pressed={configuration.shape === option.value} onClick={() => setConfiguration((current) => ({ ...current, shape: option.value }))} className={`rounded-full border px-3 py-2 text-xs font-semibold ${configuration.shape === option.value ? "border-neutral-950 bg-neutral-950 text-white" : "border-neutral-300 text-neutral-700"}`}>{option.label}</button>)}</div></fieldset>
            <fieldset><legend className="text-sm font-semibold text-neutral-900">3. {L("Color", "Màu")}</legend><div className="mt-2 grid grid-cols-4 gap-2">{COLORS.map((option) => <button key={option.value} type="button" aria-pressed={configuration.color === option.value} onClick={() => setConfiguration((current) => ({ ...current, color: option.value }))} className={`rounded-2xl border p-2 text-center text-[11px] font-semibold ${configuration.color === option.value ? "border-neutral-950 ring-2 ring-neutral-950/20" : "border-neutral-200"}`}><span className="mx-auto block h-8 w-8 rounded-full border border-black/10" style={{ background: option.swatch }} /><span className="mt-1 block">{option.label}</span></button>)}</div></fieldset>
            <fieldset><legend className="text-sm font-semibold text-neutral-900">4. {L("Style", "Kiểu sơn")}</legend><div className="mt-2 flex flex-wrap gap-2">{ART_STYLES.map((option) => <button key={option.value} type="button" aria-pressed={configuration.artStyle === option.value} onClick={() => setConfiguration((current) => ({ ...current, artStyle: option.value }))} className={`rounded-full border px-3 py-2 text-xs font-semibold ${configuration.artStyle === option.value ? "border-neutral-950 bg-neutral-950 text-white" : "border-neutral-300 text-neutral-700"}`}>{option.label}</button>)}</div></fieldset>
            <fieldset><legend className="text-sm font-semibold text-neutral-900">5. {L("Finish", "Hiệu ứng")}</legend><div className="mt-2 flex flex-wrap gap-2">{FINISHES.map((option) => <button key={option.value} type="button" aria-pressed={configuration.finish === option.value} onClick={() => setConfiguration((current) => ({ ...current, finish: option.value }))} className={`rounded-full border px-3 py-2 text-xs font-semibold ${configuration.finish === option.value ? "border-neutral-950 bg-neutral-950 text-white" : "border-neutral-300 text-neutral-700"}`}>{option.label}</button>)}</div></fieldset>
          </div>
          <h3 className="mt-6 text-sm font-semibold text-neutral-900">6. {L("Decoration", "Mẫu trang trí")}</h3>
          {designs.length ? <div className="mt-5 grid grid-cols-2 gap-3">{designs.map((design) => (
            <button key={design.id} type="button" disabled={busy} onClick={() => void generate(design.id)} className="overflow-hidden rounded-2xl border border-neutral-200 text-left transition hover:border-neutral-500 disabled:opacity-60">
              {design.previewUrl ? <img src={design.previewUrl} alt={design.name} className="aspect-square w-full object-cover" /> : <div className="aspect-square bg-neutral-100" />}
              <span className="block p-3 text-sm font-semibold text-neutral-900">{design.name}</span>
            </button>
          ))}</div> : <p className="mt-5 rounded-2xl bg-neutral-50 p-4 text-sm text-neutral-600">{L("This salon has not published try-on designs yet.", "Salon chưa đăng mẫu thử nào.")}</p>}
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
            {resultUrl ? <><p className="text-xs font-semibold uppercase tracking-widest text-emerald-700">{L("AI preview ready", "Ảnh thử AI đã sẵn sàng")}</p><h2 className="mt-2 text-2xl font-semibold text-neutral-950">{L("See yourself in this look", "Xem mẫu trên tay bạn")}</h2><p className="mt-2 text-sm text-neutral-600">{L("AI preview—actual color and result may vary.", "Ảnh thử AI—màu sắc và kết quả thực tế có thể khác.")}</p><a href={`/${salonSlug}?tryon=${encodeURIComponent(sessionId || "")}&lang=${language}`} className="mt-5 flex min-h-14 items-center justify-center rounded-full bg-neutral-950 px-5 font-semibold text-white">{L("Continue to booking", "Tiếp tục đặt lịch")}</a></> : <><p className="text-xs font-semibold uppercase tracking-widest text-blue-700">{L("Design selected", "Đã chọn mẫu")}</p><h2 className="mt-2 text-2xl font-semibold text-neutral-950">{selectedDesign?.name || L("Preparing your look", "Đang chuẩn bị mẫu")}</h2>{busy ? <p className="mt-3 rounded-2xl bg-blue-50 p-4 text-sm text-blue-900" role="status">{generationSeconds < 20 ? L("Preparing your nail preview…", "Đang chuẩn bị ảnh…") : generationSeconds < 50 ? L("Applying the design to your nails…", "Đang thử mẫu lên móng…") : L("Adding final details—please keep this page open.", "Đang hoàn thiện, vui lòng giữ trang này mở.")}</p> : null}{serverMessage ? <p className="mt-3 rounded-2xl bg-red-50 p-4 text-sm text-red-800" role="alert">{serverMessage}</p> : null}{!busy ? <><button type="button" onClick={() => { setServerMessage(null); setStep("catalog"); }} className="mt-4 min-h-12 w-full rounded-full border border-neutral-300 px-5 font-semibold text-neutral-800">{L("Choose another design", "Chọn mẫu khác")}</button>{serverMessage ? <a href={`/${salonSlug}?lang=${language}`} className="mt-3 flex min-h-12 w-full items-center justify-center rounded-full bg-neutral-950 px-5 text-center font-semibold text-white">{L("Continue booking without a preview", "Tiếp tục đặt lịch không cần ảnh thử")}</a> : null}</> : null}</>}
          </div>
        </section>
      ) : !consented ? (
        <section className="rounded-[28px] border border-black/5 bg-white p-6 shadow-[0_12px_40px_rgba(0,0,0,0.06)]">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-700"><ShieldCheck aria-hidden /></div>
          <h2 className="mt-5 text-center text-xl font-semibold text-neutral-950">{L("Your photo stays private", "Ảnh của bạn được bảo mật")}</h2>
          <p className="mx-auto mt-2 max-w-sm text-center text-sm leading-6 text-neutral-600">
            {L("Used only for your AI preview. Unused photos are deleted after 24 hours.", "Chỉ dùng để tạo ảnh thử mẫu AI. Ảnh không dùng sẽ được xóa sau 24 giờ.")}
          </p>
          <label className="mt-6 flex cursor-pointer gap-3 rounded-2xl bg-neutral-50 p-4 text-sm leading-5 text-neutral-700">
            <input type="checkbox" checked={consentChecked} onChange={(event) => setConsentChecked(event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-black" />
            <span>{L("I agree to process this photo and understand the preview may differ from the final result.", "Tôi đồng ý xử lý ảnh này và hiểu rằng ảnh thử có thể khác kết quả thực tế.")}</span>
          </label>
          <button
            type="button"
            disabled={!consentChecked}
            onClick={() => setConsented(true)}
            className="mt-4 min-h-14 w-full rounded-full bg-neutral-950 px-5 text-base font-semibold text-white transition disabled:bg-neutral-200 disabled:text-neutral-400"
          >
            {L("Continue", "Tiếp tục")}
          </button>
        </section>
      ) : (
        <section className="overflow-hidden rounded-3xl border border-neutral-200 bg-white shadow-xl shadow-black/5">
          {!previewUrl ? (
            <div className="p-5 sm:p-7">
              <div className="mb-4 grid grid-cols-2 rounded-2xl bg-neutral-100 p-1" aria-label={L("Photo capture mode", "Cách chụp ảnh")}>
                <button
                  type="button"
                  aria-pressed={captureMode === "single"}
                  onClick={() => chooseCaptureMode("single")}
                  className={`min-h-11 rounded-xl px-3 text-sm font-semibold transition ${captureMode === "single" ? "bg-white text-neutral-950 shadow-sm" : "text-neutral-500"}`}
                >
                  {L("One photo", "Một ảnh")}
                </button>
                <button
                  type="button"
                  aria-pressed={captureMode === "four_plus_one"}
                  onClick={() => chooseCaptureMode("four_plus_one")}
                  className={`min-h-11 rounded-xl px-3 text-sm font-semibold transition ${captureMode === "four_plus_one" ? "bg-white text-neutral-950 shadow-sm" : "text-neutral-500"}`}
                >
                  {L("Easy 4+1", "Dễ hơn 4+1")}
                </button>
              </div>

              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-medium text-neutral-700">
                  {captureMode === "four_plus_one" ? (
                    <>
                      <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${captureStage === "thumb" ? "bg-emerald-100 text-emerald-800" : "bg-neutral-950 text-white"}`}>
                        {captureStage === "thumb" ? <Check className="h-4 w-4" aria-hidden /> : "1"}
                      </span>
                      <span>{L("Four fingers", "4 ngón")}</span>
                      <span className="h-px w-5 bg-neutral-300" />
                      <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${captureStage === "thumb" ? "bg-neutral-950 text-white" : "bg-neutral-200 text-neutral-500"}`}>2</span>
                      <span>{L("Thumb", "Ngón cái")}</span>
                    </>
                  ) : (
                    <span className="inline-flex items-center gap-2"><Sparkles className="h-4 w-4 text-amber-600" aria-hidden />{L("Smart Hand Coach", "Hướng dẫn thông minh")}</span>
                  )}
                </div>
                {captureStage !== "thumb" ? (
                  <div className="flex rounded-full bg-neutral-100 p-1" aria-label={L("Choose hand", "Chọn bàn tay")}>
                    {(["left", "right"] as const).map((side) => (
                      <button
                        key={side}
                        type="button"
                        aria-pressed={handSide === side}
                        onClick={() => setHandSide(side)}
                        className={`min-h-8 rounded-full px-3 text-xs font-semibold ${handSide === side ? "bg-white text-neutral-950 shadow-sm" : "text-neutral-500"}`}
                      >
                        {side === "left" ? L("Left", "Tay trái") : L("Right", "Tay phải")}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-3xl bg-neutral-950 text-white">
                <video
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  aria-label={L("Live rear-camera preview", "Xem trước camera sau")}
                  className={`absolute inset-0 h-full w-full object-cover ${cameraState === "live" ? "block" : "hidden"}`}
                />
                <div className="pointer-events-none absolute inset-0 bg-black/15" />
                <SmartHandGuide handSide={handSide} stage={captureStage} active={coachStatus === "countdown" || coachStatus === "capturing"} />
                {cameraState === "live" ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        stopCamera();
                        setCameraState("idle");
                        setCameraMessage(null);
                      }}
                      className="absolute right-4 top-4 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-black/65 text-white backdrop-blur"
                      aria-label={L("Close camera", "Đóng camera")}
                    >
                      <X className="h-5 w-5" aria-hidden />
                    </button>
                    {captureStage === "thumb" && fourFingerPreviewUrl ? (
                      <div className="absolute left-4 top-4 z-10 w-20 overflow-hidden rounded-xl border-2 border-emerald-400 bg-black shadow-lg">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={fourFingerPreviewUrl} alt={L("Saved four-finger photo", "Ảnh 4 ngón đã lưu")} className="aspect-square w-full object-cover" />
                        <p className="bg-black/80 px-1 py-1 text-center text-[10px] font-semibold text-white">{L("Saved", "Đã lưu")}</p>
                      </div>
                    ) : null}
                    <div className="absolute inset-x-0 bottom-4 z-10 flex flex-col items-center gap-2 px-4">
                      <p className={`rounded-full px-4 py-2 text-center text-xs font-semibold backdrop-blur ${coachStatus === "countdown" || coachStatus === "capturing" ? "bg-emerald-500/90 text-black" : "bg-black/75 text-white"}`} role="status" aria-live="polite">
                        {coachMessage}
                      </p>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={coachRunning ? stopAutoCoach : startAutoCoach}
                          disabled={coachStatus === "capturing"}
                          className="min-h-11 rounded-full bg-white px-4 text-xs font-bold text-neutral-950 shadow-lg disabled:opacity-60"
                        >
                          {coachRunning ? L("Stop", "Dừng") : L("Auto capture", "Tự chụp")}
                        </button>
                        <button
                          type="button"
                          onClick={() => void captureLivePhoto()}
                          className="flex min-h-14 min-w-14 items-center justify-center rounded-full border-4 border-white bg-white/25 shadow-lg outline-none ring-offset-2 focus-visible:ring-2 focus-visible:ring-white"
                          aria-label={L("Capture hand photo", "Chụp ảnh bàn tay")}
                        >
                          <span className="h-10 w-10 rounded-full bg-white" aria-hidden />
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={cameraState === "starting" || cameraState === "fallback"}
                    onClick={() => void startLiveCamera()}
                    className="relative z-10 flex min-h-44 w-full flex-col items-center justify-center px-6 text-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white disabled:cursor-default"
                  >
                    <span className="flex h-20 w-20 items-center justify-center rounded-full border border-white/30 bg-white/10"><Camera className="h-9 w-9" aria-hidden /></span>
                    <span className="mt-4 text-sm font-semibold">
                      {cameraState === "starting" ? L("Opening camera…", "Đang mở camera…") : cameraState === "fallback" ? L("Use a photo instead", "Hãy dùng ảnh thay thế") : L("Open camera", "Mở camera")}
                    </span>
                    <span className="mt-1 max-w-xs text-xs text-white/70">{capturePrompt}</span>
                  </button>
                )}
              </div>
              {cameraMessage ? (
                <p className="mt-4 rounded-2xl bg-amber-50 p-4 text-sm leading-6 text-amber-950" role="alert">
                  {cameraState === "fallback"
                    ? L("Camera access is unavailable. You can still take or choose a photo.", "Không thể mở camera trực tiếp. Bạn vẫn có thể chụp hoặc chọn ảnh.")
                    : cameraMessage}
                </p>
              ) : null}
              {cameraState === "fallback" ? (
                <div className="mt-4 grid gap-3">
                  {supportsDirectCapture ? (
                    <label className="relative flex min-h-14 w-full cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-full bg-neutral-950 px-5 text-base font-semibold text-white">
                      <Camera className="h-5 w-5" aria-hidden />
                      {L("Take a new photo", "Chụp ảnh mới")}
                      <input
                        ref={cameraInputRef}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                        aria-label={L("Take a new photo", "Chụp ảnh mới")}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          event.currentTarget.value = "";
                          if (file) void acceptCapturedPhoto(file);
                        }}
                      />
                    </label>
                  ) : null}
                  <label className={`relative flex w-full cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-full px-5 font-semibold ${supportsDirectCapture ? "min-h-12 border border-neutral-300 bg-white text-neutral-900" : "min-h-14 bg-neutral-950 text-base text-white"}`}>
                    <ImagePlus className="h-5 w-5" aria-hidden />
                    {L("Choose an existing photo", "Chọn ảnh có sẵn")}
                    <input
                      ref={libraryInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      aria-label={L("Choose an existing photo", "Chọn ảnh có sẵn")}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.currentTarget.value = "";
                        if (file) void acceptCapturedPhoto(file);
                      }}
                    />
                  </label>
                </div>
              ) : cameraState !== "live" ? (
                <label className="relative mt-4 flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-full text-sm font-semibold text-neutral-700">
                  <ImagePlus className="h-5 w-5" aria-hidden />
                  {L("Choose an existing photo", "Chọn ảnh có sẵn")}
                  <input
                    ref={libraryInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    aria-label={L("Choose an existing photo", "Chọn ảnh có sẵn")}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.currentTarget.value = "";
                      if (file) void acceptCapturedPhoto(file);
                    }}
                  />
                </label>
              ) : null}
              <p className="mt-3 text-center text-xs leading-5 text-neutral-500">
                {captureMode === "four_plus_one"
                  ? L("Two guided photos · One AI generation", "Hai ảnh hướng dẫn · Chỉ một lần tạo AI")
                  : L("Palm down · Thumb angled outward · Even light", "Úp bàn tay · Đưa ngón cái ra ngoài · Ánh sáng đều")}
              </p>
            </div>
          ) : (
            <div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl} alt="Your hand photo preview" className="aspect-[4/3] w-full bg-neutral-100 object-contain" />
              <div className="p-5 sm:p-7">
                {quality === "checking" ? <p className="text-center font-medium text-neutral-700" role="status">{L("Checking photo…", "Đang kiểm tra ảnh…")}</p> : null}
                {quality === "pass" ? (
                  <div className="rounded-2xl bg-emerald-50 p-4 text-center text-emerald-900" role="status"><p className="font-semibold">{L("Photo ready", "Ảnh đã sẵn sàng")}</p><p className="mt-1 text-sm">{L("One more quick check before choosing a design.", "Kiểm tra nhanh một lần nữa trước khi chọn mẫu.")}</p></div>
                ) : null}
                {quality && quality !== "checking" && quality !== "pass" ? (
                  <div className="rounded-2xl bg-amber-50 p-4 text-amber-950" role="alert"><p className="font-semibold">{BLOCKING_CLIENT_CODES.has(quality) ? L("Choose another photo", "Hãy chọn ảnh khác") : L("Photo quality warning", "Ảnh chưa thật rõ")}</p><p className="mt-1 text-sm">{COPY[quality][language]}</p></div>
                ) : null}
                {serverMessage ? <p className="mt-3 rounded-2xl bg-red-50 p-4 text-sm text-red-800" role="alert">{serverMessage}</p> : null}
                {serverWarning ? <p className="mt-3 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900" role="status">{serverWarning}</p> : null}
                {quality && quality !== "checking" && !BLOCKING_CLIENT_CODES.has(quality) ? <button type="button" disabled={busy} onClick={() => void uploadAndVerify()} className="mt-4 min-h-14 w-full rounded-full bg-neutral-950 px-5 text-base font-semibold text-white disabled:bg-neutral-300 disabled:text-neutral-600">{busy ? L("Checking hand…", "Đang kiểm tra bàn tay…") : quality === "pass" ? L("Use this photo", "Dùng ảnh này") : L("Use anyway", "Vẫn dùng ảnh này")}</button> : null}
                <button type="button" onClick={() => reset()} className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-full text-sm font-semibold text-neutral-700"><RotateCcw className="h-4 w-4" aria-hidden />{L("Retake", "Chụp lại")}</button>
              </div>
            </div>
          )}
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

      <a href={`/${salonSlug}?lang=${language}`} className="mx-auto mt-6 block w-fit text-sm font-medium text-neutral-600 underline-offset-4 hover:underline">{L("Back to booking", "Quay lại đặt lịch")}</a>
    </div>
  );
}
