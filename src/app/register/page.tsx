"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";
import { getRegisterFlow, setRegisterFlow } from "@/shared/lib/registerFlow";
import { sendRegisterOtp } from "@/shared/register/actions";
import {
  isRegisterPhoneDigitsValid,
  normalizeRegisterPhone,
} from "@/shared/register/phone";

export default function RegisterPage() {
  const router = useRouter();
  const [phoneRaw, setPhoneRaw] = useState(() =>
    typeof window !== "undefined" ? getRegisterFlow().phone : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const normalized = normalizeRegisterPhone(phoneRaw);
      if (!isRegisterPhoneDigitsValid(normalized)) {
        setError(
          "Enter 8–15 digits including country code (e.g. Vietnam: 84912345678).",
        );
        return;
      }
      setError(null);
      startTransition(async () => {
        const result = await sendRegisterOtp(phoneRaw);
        if (!result.success) {
          setError(result.error);
          return;
        }
        setRegisterFlow({
          phone: normalized,
          verified: false,
          completionToken: "",
          salonName: "",
          slug: "",
        });
        router.push("/register/verify");
      });
    },
    [phoneRaw, router],
  );

  return (
    <RegisterStepShell
      title="Verify your number"
      subtext="We’ll text you a one-time code to confirm it’s you. SMS isn’t wired yet—this build logs the code in the server console for demo."
    >
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Badge variant="default" className="uppercase tracking-[0.14em]">
          DEMO MODE
        </Badge>
        <span className="text-xs leading-snug text-nq-muted">
          Codes appear in your dev terminal only—not sent by SMS yet.
        </span>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-6">
        <div>
          <Input
            suppressHydrationWarning
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            placeholder="Mobile number"
            value={phoneRaw}
            onChange={(ev) => {
              setPhoneRaw(ev.target.value);
              if (error) setError(null);
            }}
            aria-invalid={Boolean(error)}
            error={Boolean(error)}
            autoFocus
          />
          {error ? (
            <p className="mt-2 text-sm text-nq-error" role="status">
              {error}
            </p>
          ) : null}
        </div>
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending ? "Sending…" : "Send code"}
        </Button>
      </form>
    </RegisterStepShell>
  );
}
