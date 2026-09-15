import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/shared/lib/supabase/server";
import { getSuperAdminRole } from "@/shared/lib/superadmin";
import { SuperadminLoginForm, SuperadminLoginIntro } from "./SuperadminLoginForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Sign in · NailIQ SuperAdmin" },
  robots: { index: false, follow: false },
};

/**
 * Superadmin sign-in surface (email + password).
 *
 * If the visitor is already signed in AND has an active superadmin
 * role, fast-forward to /superadmin so re-visiting the login URL
 * doesn't strand them on a form they don't need. Anyone else gets
 * the form — including authenticated salon owners who happen to
 * navigate here.
 *
 * Per docs/PERMISSION_MATRIX.md §8.4 we deliberately do not enumerate
 * who has access; salon owners reaching this URL simply see the form,
 * never a "you're not a superadmin" message.
 */
export default async function SuperadminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string; notice?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const role = await getSuperAdminRole(user.id);
    if (role !== null) {
      redirect("/superadmin");
    }
  }

  const params = await searchParams;
  const justReset = params.reset === "ok";
  const reauthenticationRequired =
    params.notice === "reauthentication_required";

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-8 px-5 py-16 md:px-8">
      <SuperadminLoginIntro justReset={justReset} reauthenticationRequired={reauthenticationRequired} />

      <SuperadminLoginForm />
    </main>
  );
}
