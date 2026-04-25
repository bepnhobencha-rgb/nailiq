"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";
import {
  getRegisterFlow,
  setRegisterFlow,
  slugifySalonName,
} from "@/shared/lib/registerFlow";

export default function RegisterSetupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const s = getRegisterFlow();
    if (!s.verified) {
      router.replace("/register/verify");
      return;
    }
    if (s.salonName) setName(s.salonName);
    setReady(true);
  }, [router]);

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = name.trim();
      if (!trimmed) return;
      const slug = slugifySalonName(trimmed);
      setRegisterFlow({ salonName: trimmed, slug });
      router.push("/register/success");
    },
    [name, router],
  );

  if (!ready) {
    return (
      <RegisterStepShell title="What’s your salon name?">
        <div className="h-32 rounded-2xl bg-nq-surface/50" />
      </RegisterStepShell>
    );
  }

  return (
    <RegisterStepShell
      title="What’s your salon name?"
      subtext="This will appear on your public booking page."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-6">
        <Input
          name="salonName"
          placeholder="e.g. A Nails"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="organization"
          autoFocus
        />
        <Button type="submit" size="lg" className="w-full" disabled={!name.trim()}>
          Create your booking page
        </Button>
      </form>
    </RegisterStepShell>
  );
}
