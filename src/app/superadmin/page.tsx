import { redirect } from "next/navigation";
import { createClient } from "@/shared/lib/supabase/server";
import { isSuperAdmin } from "@/shared/lib/superadmin";
import {
  loadAllSalons,
  loadPlatformFlags,
} from "@/shared/superadmin/superadminActions";
import { SuperAdminPanel } from "@/components/superadmin/SuperAdminPanel";

export const dynamic = "force-dynamic";

export default async function SuperAdminPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  if (!(await isSuperAdmin(user.id))) {
    // Not a superadmin — bounce to login. We don't reveal that the page
    // exists with a 403 because the route should be invisible to anyone
    // who isn't on the superadmins table.
    redirect("/login");
  }

  const [salonsResult, platformFlagsResult] = await Promise.all([
    loadAllSalons(),
    loadPlatformFlags(),
  ]);

  if (!salonsResult.ok) {
    return (
      <main className="mx-auto w-full max-w-3xl px-5 py-12 md:px-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          🔐 NailIQ SuperAdmin
        </h1>
        <p className="mt-6 rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error">
          Failed to load salons ({salonsResult.error}). Check
          SUPABASE_SERVICE_ROLE_KEY and the migration state.
        </p>
      </main>
    );
  }

  return (
    <SuperAdminPanel
      salons={salonsResult.salons}
      viewerEmail={user.email ?? null}
      initialPlatformFlags={
        platformFlagsResult.ok ? platformFlagsResult.flags : []
      }
      platformFlagsError={
        platformFlagsResult.ok ? null : platformFlagsResult.error
      }
    />
  );
}
