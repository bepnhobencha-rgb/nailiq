"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";
import { setRegisterFlow } from "@/shared/lib/registerFlow";

const FAKE_CODE = "1234";

export default function RegisterVerifyPage() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const digits = value.replace(/\D/g, "");
      if (digits !== FAKE_CODE) {
        setError("Code doesn’t match. Try 1234 for this demo.");
        return;
      }
      setError(null);
      setRegisterFlow({ verified: true });
      router.push("/register/setup");
    },
    [value, router],
  );

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const d = e.target.value.replace(/\D/g, "").slice(0, 4);
    setValue(d);
    if (error) setError(null);
  };

  return (
    <RegisterStepShell
      title="Enter code"
      subtext="We sent a 4-digit code to your number."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-6">
        <div>
          <Input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="0000"
            value={value}
            onChange={onChange}
            className="text-center font-mono text-2xl tracking-[0.45em] sm:text-3xl"
            aria-label="4-digit code"
            maxLength={4}
            autoFocus
            error={Boolean(error)}
          />
          {error ? (
            <p className="mt-2 text-sm text-nq-error" role="status">
              {error}
            </p>
          ) : null}
        </div>
        <Button type="submit" size="lg" className="w-full" disabled={value.length < 4}>
          Continue
        </Button>
      </form>
    </RegisterStepShell>
  );
}
