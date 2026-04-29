import type { Metadata } from "next";
import { DebugSentryClient } from "./DebugSentryClient";

export const metadata: Metadata = {
  title: "Diagnostics",
  robots: { index: false, follow: false },
};

export default function DebugSentryPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 py-16">
      <p className="text-sm text-nq-muted">
        No public content here.
      </p>
      <DebugSentryClient />
    </main>
  );
}
