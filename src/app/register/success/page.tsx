"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";
import { getRegisterFlow } from "@/shared/lib/registerFlow";
import { getSiteUrlForClient } from "@/shared/lib/siteUrlClient";

export default function RegisterSuccessPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [publicUrl, setPublicUrl] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const s = getRegisterFlow();
    if (!s.verified) {
      router.replace("/register/verify");
      return;
    }
    if (!s.slug) {
      router.replace("/register/setup");
      return;
    }
    const base = getSiteUrlForClient().replace(/\/$/, "");
    setPublicUrl(`${base}/${s.slug}`);
    setReady(true);
  }, [router]);

  const copy = useCallback(async () => {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }, [publicUrl]);

  const openLink = useCallback(() => {
    if (!publicUrl) return;
    window.open(publicUrl, "_blank", "noopener,noreferrer");
  }, [publicUrl]);

  if (!ready) {
    return (
      <RegisterStepShell title="Your booking page is ready">
        <div className="h-40 rounded-2xl bg-nq-surface/50" />
      </RegisterStepShell>
    );
  }

  return (
    <RegisterStepShell
      title="Your booking page is ready"
      subtext="Send this link to your clients to start getting bookings"
    >
      <div className="flex flex-col gap-4">
        <p className="text-center text-xs text-nq-muted sm:text-sm">Your link</p>
        <div className="break-all rounded-2xl border border-nq-border/40 bg-nq-surface/50 px-4 py-3 text-center text-sm text-nq-foreground/95 sm:text-base">
          {publicUrl}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:gap-3">
          <Button
            type="button"
            size="lg"
            variant="primary"
            className="w-full min-w-0"
            onClick={copy}
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
          <Button
            type="button"
            size="lg"
            variant="secondary"
            className="w-full min-w-0"
            onClick={openLink}
          >
            Open link
          </Button>
        </div>
        <p className="pt-2 text-center text-sm leading-relaxed text-nq-muted">
          You can return anytime:{" "}
          <Link
            href="/"
            className="text-nq-primary-soft/95 underline decoration-nq-primary/30 underline-offset-2 transition-opacity hover:opacity-90"
          >
            Home
          </Link>
        </p>
      </div>
    </RegisterStepShell>
  );
}
