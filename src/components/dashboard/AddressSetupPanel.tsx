"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { SaveButton, type SaveButtonStatus } from "@/components/ui/SaveButton";
import { SetupToast, type SetupToastPayload } from "@/components/ui/Toast";
import { updateAddress } from "@/shared/dashboard/setupActions";

const TOAST_ERR = "✗ Could not save. Check your connection.";

export function AddressSetupPanel({
  slug,
  initialAddress,
  initialSalonPhone,
}: {
  slug: string;
  initialAddress: string;
  initialSalonPhone: string;
}) {
  const router = useRouter();
  const [address, setAddress] = useState(initialAddress);
  const [salonPhone, setSalonPhone] = useState(initialSalonPhone);
  const [saveStatus, setSaveStatus] = useState<SaveButtonStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<SetupToastPayload | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearStatusTimer = useCallback(() => {
    if (statusTimerRef.current !== null) {
      clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      clearStatusTimer();
    },
    [clearStatusTimer],
  );

  // Sync when server passes new defaults after `router.refresh()`.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- props → local form state */
    setAddress(initialAddress);
    setSalonPhone(initialSalonPhone);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [initialAddress, initialSalonPhone]);

  const save = useCallback(async () => {
    setError(null);
    clearStatusTimer();
    setSaveStatus("saving");
    const res = await updateAddress(slug, { address, salon_phone: salonPhone });
    if (!res.ok) {
      setSaveStatus("error");
      if (res.error === "invalid_address") {
        setError("Enter your full salon address.");
      } else if (res.error === "invalid_phone") {
        setError("Enter a valid salon phone number.");
      } else {
        setError("Could not save. Try again.");
      }
      setToast({ variant: "error", message: TOAST_ERR });
      statusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 3000);
      return;
    }
    setSaveStatus("saved");
    setToast({ variant: "success", message: "✓ Address saved" });
    statusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
    router.refresh();
  }, [address, clearStatusTimer, salonPhone, router, slug]);

  return (
    <div className="flex flex-col gap-4">
      <SetupToast toast={toast} onDismiss={() => setToast(null)} />

      {error ? (
        <p className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error">
          {error}
        </p>
      ) : null}
      <label className="block text-sm font-medium text-nq-muted">
        Salon address
        <textarea
          className="mt-1.5 min-h-[120px] w-full resize-y rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-3 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus"
          value={address}
          disabled={saveStatus === "saving"}
          onChange={(e) => {
            setAddress(e.target.value);
          }}
          placeholder="Street, city, postal code"
        />
      </label>
      <label className="block text-sm font-medium text-nq-muted">
        Salon phone
        <span className="block text-xs font-normal text-nq-muted/85">
          Different from the number you used to sign up, if you prefer.
        </span>
        <input
          inputMode="tel"
          autoComplete="tel"
          className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus"
          value={salonPhone}
          disabled={saveStatus === "saving"}
          onChange={(e) => {
            setSalonPhone(e.target.value);
          }}
          placeholder="(555) 000-0000"
        />
      </label>
      <SaveButton
        status={saveStatus}
        onSave={() => {
          void save();
        }}
        className="min-h-[48px] w-full sm:w-full"
      />
    </div>
  );
}
