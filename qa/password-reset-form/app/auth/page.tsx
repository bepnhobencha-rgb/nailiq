import { SocialAuthButtons } from "@/components/auth/SocialAuthButtons";

export default async function Page({ searchParams }: {
  searchParams: Promise<{ surface?: string }>;
}) {
  const { surface = "login" } = await searchParams;
  return (
    <main className="min-h-screen bg-nq-bg p-6 text-nq-foreground">
      <div className="mx-auto max-w-md">
        <h1>Auth form QA</h1>
        <SocialAuthButtons
          mode={surface === "register" ? "register" : "login"}
          layout={surface === "compact" ? "compact" : "open"}
          enablePassword={surface === "login" || surface === "register"}
        />
      </div>
    </main>
  );
}
