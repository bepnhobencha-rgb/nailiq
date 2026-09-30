import { SuperadminLoginForm, SuperadminLoginIntro } from "@/app/superadmin/login/SuperadminLoginForm";
// Presentational client components only; no production session guard is imported.
export default async function Page({ searchParams }: { searchParams: Promise<{ reset?: string; notice?: string }> }) {
  const params = await searchParams;
  return <main className="mx-auto flex w-full max-w-md flex-col gap-8 px-5 py-16 md:px-8"><SuperadminLoginIntro justReset={params.reset === "ok"} reauthenticationRequired={params.notice === "reauthentication_required"} /><SuperadminLoginForm /></main>;
}
