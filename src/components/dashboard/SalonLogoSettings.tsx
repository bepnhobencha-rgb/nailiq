"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/Button";
import { removeSalonLogo, uploadSalonLogo } from "@/shared/dashboard/salonOwnerActions";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

const ACCEPT = "image/png,image/jpeg,image/webp,image/svg+xml";
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Owner/admin upload for `salons.logo_url`, rendered on the booking header.
 *
 * Size and MIME are checked here for a fast, friendly message; the server
 * action re-checks both, since a client-side guard is a hint, not a control.
 */
export function SalonLogoSettings({
  slug,
  initialLogoUrl,
}: {
  slug: string;
  initialLogoUrl: string | null;
}) {
  const { language } = useUserLanguage();
  const t = getUserMessages(language).salonSettings.salonLogo;
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [logoUrl, setLogoUrl] = useState<string | null>(initialLogoUrl);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pending, startTransition] = useTransition();

  function errorMessage(code: string): string {
    if (code === "file_too_large") return t.errorTooLarge;
    if (code === "invalid_type") return t.errorInvalidType;
    return t.errorGeneric;
  }

  async function onPick(file: File) {
    setError(null);
    if (file.size > MAX_BYTES) return setError(t.errorTooLarge);
    if (!ACCEPT.split(",").includes(file.type)) return setError(t.errorInvalidType);

    setUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    const res = await uploadSalonLogo(slug, fd);
    setUploading(false);

    if (!res.ok) return setError(errorMessage(res.error));
    setLogoUrl(res.logoUrl);
    startTransition(() => router.refresh());
  }

  function onRemove() {
    setError(null);
    startTransition(async () => {
      const res = await removeSalonLogo(slug);
      if (!res.ok) return setError(errorMessage(res.error));
      setLogoUrl(null);
      router.refresh();
    });
  }

  const busy = uploading || pending;

  return (
    <section data-testid="salon-logo-settings" className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-nq-foreground">{t.sectionTitle}</h3>
        <p className="mt-1 text-sm text-nq-foreground/70">{t.intro}</p>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-nq-foreground/15 bg-nq-foreground/5">
          {logoUrl ? (
            // Plain <img>: next.config has no images.remotePatterns, and the
            // logo lives on the Supabase storage host.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt={t.previewAlt}
              className="h-full w-full object-contain"
              data-testid="salon-logo-preview"
            />
          ) : (
            <span aria-hidden="true" className="text-2xl opacity-30">
              ⬚
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            data-testid="salon-logo-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onPick(f);
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            data-testid="salon-logo-upload"
          >
            {uploading ? t.uploading : logoUrl ? t.replaceCta : t.uploadCta}
          </Button>
          {logoUrl ? (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={onRemove}
              data-testid="salon-logo-remove"
            >
              {pending ? t.removing : t.remove}
            </Button>
          ) : null}
        </div>
      </div>

      {!logoUrl && !error ? <p className="text-sm text-nq-foreground/60">{t.empty}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-red-500" data-testid="salon-logo-error">
          {error}
        </p>
      ) : null}
      <p className="text-xs text-nq-foreground/50">{t.hint}</p>
    </section>
  );
}
