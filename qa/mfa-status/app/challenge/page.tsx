import { MfaChallengeForm } from "@/components/superadmin/MfaChallengeForm";
export default function Page() {
  return <main className="flex min-h-dvh items-center justify-center bg-nq-bg px-4">
    <div className="w-full max-w-sm rounded-2xl border border-nq-border/50 bg-nq-surface/60 p-6 shadow-nq-card">
      <h1 className="text-xl font-semibold text-nq-foreground">Two-factor verification</h1>
      <p className="mt-1 text-sm text-nq-muted">Enter the 6-digit code from your authenticator app to continue.</p>
      <div className="mt-5"><MfaChallengeForm /></div>
    </div>
  </main>;
}
