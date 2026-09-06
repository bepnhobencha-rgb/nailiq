import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { createClient } from "@/shared/lib/supabase/server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Workspace created · Đã tạo salon",
  description: "Continue Coco Setup before opening public booking.",
};

export default async function RegisterSuccessLayout({
  children,
}: {
  children: ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // This guard must run on the server before the success page is rendered.
  // A client-side effect briefly exposed the success state to signed-out users.
  if (!user) {
    redirect("/register");
  }

  return children;
}
