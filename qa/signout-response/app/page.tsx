"use client";
import { ChooseSalonClient } from "@/components/auth/ChooseSalonClient";
import { LogoutButton } from "@/components/dashboard/LogoutButton";
import { SuperadminSignOutButton } from "@/components/superadmin/SuperadminSignOutButton";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
function Surface() {
 const { language } = useUserLanguage();
 const surface = useSearchParams().get("surface") || "choose";
 if (surface === "choose") return <ChooseSalonClient cards={[]} unavailable />;
 return <main className="min-h-screen bg-nq-bg p-6 text-nq-foreground">
  <h1 className="mb-8">QA {surface}</h1>
  <aside style={{ width: surface === "compact" ? 48 : 240, height: 120, overflow: "hidden", transform: "translateZ(0)" }}>
   {surface === "dashboard" ? <LogoutButton language={language} /> : <SuperadminSignOutButton compact={surface === "compact"} />}
  </aside>
 </main>;
}

export default function Page() { return <Suspense><Surface /></Suspense>; }
