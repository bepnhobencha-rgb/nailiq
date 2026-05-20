import type { Metadata } from "next";
import { loadPlatformSettings } from "@/shared/superadmin/superadminActions";
import { PlatformSettingsAdmin } from "@/components/superadmin/PlatformSettingsAdmin";

export const metadata: Metadata = {
  title: "Platform Settings · SuperAdmin",
};

export default async function SuperAdminSettingsPage() {
  const result = await loadPlatformSettings();

  if (!result.ok) {
    return (
      <div className="p-6">
        <p className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error">
          {result.error === "unauthorized"
            ? "Access denied."
            : "Could not load settings. Check Supabase logs."}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-nq-foreground">
          Platform Settings
        </h1>
        <p className="mt-1 text-sm text-nq-muted">
          Platform-wide credentials. Changes take effect immediately — no
          redeploy needed. Secrets are masked after save.
        </p>
      </header>

      <PlatformSettingsAdmin initial={result.settings} />
    </div>
  );
}
