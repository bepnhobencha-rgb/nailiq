import { notFound, redirect } from "next/navigation";
import { createClient } from "@/shared/lib/supabase/server";
import { getSuperAdminRole } from "@/shared/lib/superadmin";
import { loadAllSalons } from "@/shared/superadmin/superadminActions";
import { SuperAdminPanel } from "@/components/superadmin/SuperAdminPanel";

export const dynamic = "force-dynamic";

export default async function SuperAdminPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/superadmin/login");
  }

  const role = await getSuperAdminRole(user.id);
  if (role === null) {
    // Not a superadmin — 404 instead of redirecting. Per
    // docs/PERMISSION_MATRIX.md §8.3 we do not leak that the route
    // exists to authenticated salon owners.
    notFound();
  }

  const result = await loadAllSalons();
  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-3xl px-5 py-12 md:px-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          🔐 NailIQ SuperAdmin
        </h1>
        <p className="mt-6 rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error">
          Failed to load salons ({result.error}). Check
          SUPABASE_SERVICE_ROLE_KEY and the migration state.
        </p>
      </main>
    );
  }

  return <SuperAdminPanel salons={result.salons} viewerEmail={user.email ?? null} />;
}
