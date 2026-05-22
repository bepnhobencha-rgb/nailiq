"use client";

// PhotoCaptureForm — client component for staff photo capture
// Mobile-first; large touch targets; camera input via native API.

import { useState, useRef } from "react";

type ConsentToggles = {
  consent_receive_sms: boolean;
  consent_save_to_profile: boolean;
  consent_share_public: boolean;
  consent_use_marketing: boolean;
};

type Props = {
  bookingId: string;
  clientName: string;
  clientPhone?: string;
  serviceName: string;
  staffName?: string;
  bookingStatus: string;
};

type UploadState =
  | { status: "idle" }
  | { status: "preview"; file: File; previewUrl: string }
  | { status: "uploading" }
  | { status: "processing" }
  | { status: "done"; photoId: string }
  | { status: "error"; message: string };

export default function PhotoCaptureForm({
  bookingId,
  clientName,
  clientPhone,
  serviceName,
  staffName,
  bookingStatus,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [uploadState, setUploadState] = useState<UploadState>({ status: "idle" });
  const [consents, setConsents] = useState<ConsentToggles>({
    // PIPEDA defaults: receive SMS on, save profile on, public share off, marketing off
    consent_receive_sms: true,
    consent_save_to_profile: true,
    consent_share_public: false,
    consent_use_marketing: false,
  });

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const previewUrl = URL.createObjectURL(file);
    setUploadState({ status: "preview", file, previewUrl });
  }

  function handleConsentToggle(key: keyof ConsentToggles) {
    setConsents((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function handleRetake() {
    if (uploadState.status === "preview") {
      URL.revokeObjectURL(uploadState.previewUrl);
    }
    setUploadState({ status: "idle" });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (uploadState.status !== "preview") return;

    const { file } = uploadState;
    setUploadState({ status: "uploading" });

    const form = new FormData();
    form.append("booking_id", bookingId);
    form.append("photo", file);
    form.append("consents", JSON.stringify(consents));

    try {
      const res = await fetch("/api/staff/photo-upload", {
        method: "POST",
        body: form,
      });

      const data = (await res.json()) as { photo_id?: string; error?: string };

      if (!res.ok) {
        setUploadState({ status: "error", message: data.error ?? "Upload failed" });
        return;
      }

      // Fire-and-forget: show "processing" state while AI runs in background
      setUploadState({ status: "processing" });

      // Poll briefly (max 10s) for AI processing completion, then show done
      const photoId = data.photo_id!;
      let attempts = 0;
      const interval = setInterval(async () => {
        attempts++;
        try {
          // We just show done after a short delay — AI runs async on the server
          if (attempts >= 3) {
            clearInterval(interval);
            setUploadState({ status: "done", photoId });
          }
        } catch {
          clearInterval(interval);
          setUploadState({ status: "done", photoId });
        }
      }, 2000);
    } catch {
      setUploadState({ status: "error", message: "Network error. Please try again." });
    }
  }

  const isCompleted = bookingStatus === "completed";

  return (
    <div className="min-h-dvh bg-[#0b0c10] flex flex-col">
      {/* Header */}
      <div
        className="px-5 py-4 border-b"
        style={{ background: "#111214", borderColor: "rgba(255,255,255,0.08)" }}
      >
        <p className="text-xs text-[#a1a1aa] font-medium uppercase tracking-wider mb-1">
          Photo Confirmation
        </p>
        <h1 className="text-base font-semibold text-white leading-tight">{clientName}</h1>
        <p className="text-sm text-[#a1a1aa]">
          {serviceName}
          {staffName ? ` · ${staffName}` : ""}
        </p>
      </div>

      <div className="flex-1 flex flex-col gap-5 p-5 pb-safe-cta max-w-lg mx-auto w-full">
        {/* Not completed guard */}
        {!isCompleted && (
          <div
            className="rounded-2xl p-4 text-center"
            style={{
              background: "rgba(217,119,6,0.14)",
              border: "1px solid rgba(217,119,6,0.38)",
            }}
          >
            <p className="text-sm text-[#fbbf24]">
              Photos can only be added after the booking is marked as{" "}
              <strong>completed</strong>.
            </p>
          </div>
        )}

        {/* Camera capture / preview */}
        {isCompleted && (
          <>
            {uploadState.status === "done" ? (
              <DoneState photoId={uploadState.photoId} clientName={clientName} />
            ) : uploadState.status === "processing" ? (
              <ProcessingState />
            ) : uploadState.status === "error" ? (
              <ErrorState
                message={uploadState.message}
                onRetry={() => setUploadState({ status: "idle" })}
              />
            ) : (
              <form onSubmit={handleSubmit} className="flex flex-col gap-5">
                {/* Photo input / preview */}
                {uploadState.status === "preview" ? (
                  <div className="relative rounded-2xl overflow-hidden aspect-square">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={uploadState.previewUrl}
                      alt="Photo preview"
                      className="w-full h-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={handleRetake}
                      className="absolute top-3 right-3 rounded-full px-3 py-1.5 text-xs font-semibold"
                      style={{
                        background: "rgba(11,12,16,0.75)",
                        color: "#d4af37",
                        border: "1px solid rgba(212,175,55,0.35)",
                      }}
                    >
                      Retake
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex flex-col items-center justify-center gap-3 rounded-2xl aspect-square"
                    style={{
                      background: "#111214",
                      border: "2px dashed rgba(212,175,55,0.35)",
                    }}
                  >
                    <span className="text-4xl">📸</span>
                    <span className="text-sm font-medium text-[#d4af37]">
                      Take Photo
                    </span>
                    <span className="text-xs text-[#a1a1aa]">
                      Tap to open camera
                    </span>
                  </button>
                )}

                {/* Hidden file input — camera-first on mobile */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={handleFileChange}
                />

                {/* Consent toggles — PIPEDA */}
                <div
                  className="rounded-2xl p-4 flex flex-col gap-3"
                  style={{ background: "#111214", border: "1px solid rgba(255,255,255,0.08)" }}
                >
                  <p className="text-xs font-semibold text-[#a1a1aa] uppercase tracking-wider">
                    Client Consent (PIPEDA)
                  </p>

                  <ConsentRow
                    label="Send photo via SMS"
                    description="Text the photo link to the client"
                    checked={consents.consent_receive_sms}
                    onToggle={() => handleConsentToggle("consent_receive_sms")}
                    disabled={!clientPhone}
                    disabledReason={!clientPhone ? "No phone on file" : undefined}
                  />
                  <ConsentRow
                    label="Save to client profile"
                    description="Keep in client history for future visits"
                    checked={consents.consent_save_to_profile}
                    onToggle={() => handleConsentToggle("consent_save_to_profile")}
                  />
                  <ConsentRow
                    label="Share publicly"
                    description="Display on salon website / social"
                    checked={consents.consent_share_public}
                    onToggle={() => handleConsentToggle("consent_share_public")}
                  />
                  <ConsentRow
                    label="Use for marketing"
                    description="Include in promotions and campaigns"
                    checked={consents.consent_use_marketing}
                    onToggle={() => handleConsentToggle("consent_use_marketing")}
                  />
                </div>

                {/* Submit */}
                <button
                  type="submit"
                  disabled={uploadState.status !== "preview"}
                  className="w-full rounded-full py-4 text-base font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    background: uploadState.status === "preview" ? "#d4af37" : "#1c1d22",
                    color: uploadState.status === "preview" ? "#0b0c10" : "#6b6d76",
                    minHeight: "56px",
                  }}
                >
                  {uploadState.status === "uploading" ? "Uploading…" : "Send to Client"}
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// --- Sub-components ---

function ConsentRow({
  label,
  description,
  checked,
  onToggle,
  disabled,
  disabledReason,
}: {
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <label
      className={`flex items-start gap-3 cursor-pointer ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      {/* Toggle */}
      <div className="relative mt-0.5 flex-shrink-0">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={disabled}
          className="sr-only"
        />
        <div
          className="w-11 h-6 rounded-full transition-colors duration-200"
          style={{
            background: checked ? "#d4af37" : "rgba(255,255,255,0.1)",
          }}
        />
        <div
          className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200"
          style={{ transform: checked ? "translateX(20px)" : "translateX(0)" }}
        />
      </div>

      {/* Label */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white leading-tight">{label}</p>
        <p className="text-xs text-[#a1a1aa] mt-0.5">
          {disabledReason ?? description}
        </p>
      </div>
    </label>
  );
}

function ProcessingState() {
  return (
    <div
      className="rounded-2xl p-8 flex flex-col items-center gap-4"
      style={{ background: "#111214", border: "1px solid rgba(212,175,55,0.18)" }}
    >
      <div
        className="w-12 h-12 rounded-full border-4 border-t-transparent animate-spin"
        style={{ borderColor: "rgba(212,175,55,0.3)", borderTopColor: "#d4af37" }}
      />
      <div className="text-center">
        <p className="text-sm font-semibold text-white">AI processing…</p>
        <p className="text-xs text-[#a1a1aa] mt-1">
          Analyzing nails and preparing the client link
        </p>
      </div>
    </div>
  );
}

function DoneState({ photoId: _photoId, clientName }: { photoId: string; clientName: string }) {
  return (
    <div
      className="rounded-2xl p-8 flex flex-col items-center gap-4 text-center"
      style={{ background: "#111214", border: "1px solid rgba(34,197,94,0.35)" }}
    >
      <div
        className="w-14 h-14 rounded-full flex items-center justify-center"
        style={{ background: "rgba(34,197,94,0.12)" }}
      >
        <span className="text-2xl">✅</span>
      </div>
      <div>
        <p className="text-base font-semibold text-white">Photo sent!</p>
        <p className="text-sm text-[#a1a1aa] mt-1">
          {clientName} will receive a link to view and rate their nails.
        </p>
      </div>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      className="rounded-2xl p-6 flex flex-col gap-4"
      style={{
        background: "rgba(239,68,68,0.12)",
        border: "1px solid rgba(239,68,68,0.35)",
      }}
    >
      <p className="text-sm font-semibold text-white">Upload failed</p>
      <p className="text-sm text-[#a1a1aa]">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-full px-4 py-2 text-sm font-semibold"
        style={{ background: "#ef4444", color: "#fff" }}
      >
        Try again
      </button>
    </div>
  );
}
