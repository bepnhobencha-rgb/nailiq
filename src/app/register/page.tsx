import { redirect } from "next/navigation";

/**
 * /register always enters the 2-minute onboarding at verify.
 */
export default function RegisterPage() {
  redirect("/register/verify");
}
