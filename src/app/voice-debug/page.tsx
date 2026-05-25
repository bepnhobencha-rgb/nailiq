import { redirect } from "next/navigation";
import { VoiceDebugConsole } from "./console";

// Guard: only accessible in dev or when NEXT_PUBLIC_VOICE_DEBUG=1
function isAllowed(): boolean {
  if (process.env.NODE_ENV === "development") return true;
  if (process.env.NEXT_PUBLIC_VOICE_DEBUG === "1") return true;
  return false;
}

export default function VoiceDebugPage() {
  if (!isAllowed()) redirect("/");

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 p-4">
      <VoiceDebugConsole />
    </main>
  );
}
