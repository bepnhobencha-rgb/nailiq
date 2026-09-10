import { SuperadminResetPasswordForm, SuperadminResetPasswordHeader } from "@/app/superadmin/reset-password/SuperadminResetPasswordForm";
// Actual client form only; the guarded production page is never imported.
export default function Page() {
  return <main className="mx-auto flex w-full max-w-md flex-col gap-8 px-5 py-16 md:px-8"><SuperadminResetPasswordHeader /><SuperadminResetPasswordForm /></main>;
}
