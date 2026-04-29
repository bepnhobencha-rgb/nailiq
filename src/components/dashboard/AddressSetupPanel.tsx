"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { updateAddress } from "@/shared/dashboard/setupActions";

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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync when server passes new defaults after `router.refresh()`.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- props → local form state */
    setAddress(initialAddress);
    setSalonPhone(initialSalonPhone);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [initialAddress, initialSalonPhone]);

  const save = useCallback(async () => {
    setError(null);
    setSaving(true);
    const res = await updateAddress(slug, { address, salon_phone: salonPhone });
    setSaving(false);
    if (!res.ok) {
      if (res.error === "invalid_address") {
        setError("Enter your full salon address.");
      } else if (res.error === "invalid_phone") {
        setError("Enter a valid salon phone number.");
      } else {
        setError("Could not save. Try again.");
      }
      return;
    }
    router.refresh();
  }, [address, salonPhone, router, slug]);

  return (
    <div className="flex flex-col gap-4">
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
          disabled={saving}
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
          disabled={saving}
          onChange={(e) => {
            setSalonPhone(e.target.value);
          }}
          placeholder="(555) 000-0000"
        />
      </label>
      <Button
        type="button"
        variant="primary"
        size="lg"
        className="min-h-[48px] w-full touch-manipulation"
        disabled={saving}
        onClick={() => {
          void save();
        }}
      >
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}
