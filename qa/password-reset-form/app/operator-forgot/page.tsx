import { SuperadminForgotPasswordForm, SuperadminForgotPasswordIntro } from "@/app/superadmin/forgot-password/SuperadminForgotPasswordForm";
// Presentational client components only; no production session guard is imported.
export default async function Page({ searchParams }: { searchParams: Promise<{ reset?: string; notice?: string }> }) {
  const params = await searchParams;
  return <main className="mx-auto flex w-full max-w-md flex-col gap-8 px-5 py-16 md:px-8"><SuperadminForgotPasswordIntro invalidOrExpired={params.notice === "invalid_or_expired"} temporarilyUnavailable={params.notice === "temporarily_unavailable"} /><SuperadminForgotPasswordForm /></main>;
}
