import { MfaManager } from "@/components/superadmin/MfaManager";

export const dynamic = "force-dynamic";

export default function SecurityPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6 md:px-6">
      <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
        Security
      </h1>
      <p className="mt-1 text-sm text-nq-muted">
        Protect the superadmin panel.
      </p>
      <div className="mt-6">
        <MfaManager />
      </div>
    </main>
  );
}
