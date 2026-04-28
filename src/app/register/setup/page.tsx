"use client";

import dynamic from "next/dynamic";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";

const RegisterSetupInner = dynamic(() => import("./RegisterSetupInner"), {
  ssr: false,
  loading: () => (
    <RegisterStepShell title="What’s your salon name?">
      <div className="h-32 rounded-2xl bg-nq-surface/50" />
    </RegisterStepShell>
  ),
});

export default function RegisterSetupPage() {
  return <RegisterSetupInner />;
}
