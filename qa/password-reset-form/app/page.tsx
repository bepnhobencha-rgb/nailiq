import { SalonOwnerResetPasswordForm, SalonOwnerResetPasswordHeader } from "@/app/login/reset-password/SalonOwnerResetPasswordForm";
// Mount the actual component in a separate test app. Production page/session
// guards are not imported, replaced, or bypassed in the production application.
export default function Page() {
  return <main className="mx-auto flex w-full max-w-md flex-col gap-8 px-5 py-16 md:px-8"><SalonOwnerResetPasswordHeader /><SalonOwnerResetPasswordForm /></main>;
}
