import { notFound, redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isReleaseFeatureEnabled } from "@/shared/features/featureRegistry";
import { VoiceSettingsForm } from "@/components/dashboard/VoiceSettingsForm";
import { VoicePhoneSetup } from "@/components/dashboard/VoicePhoneSetup";
import type { VoiceAiSettingsInput } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export default async function VoiceSetupPage({ params }: PageProps) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");
  if (!isOwnerOrAdmin(ctx.role)) redirect(`/dashboard/${slug}/setup`);

  const { data: row } = await ctx.supabase
    .from("salons")
    .select(
      "voice_ai_enabled, voice_ai_persona_name, voice_ai_persona_voice, voice_ai_reasoning_effort, " +
        "voice_ai_sessions_this_month, voice_ai_sessions_limit, voice_ai_sessions_reset_at",
    )
    .eq("id", ctx.salon.id)
    .single();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = (row ?? {}) as any;

  // PR3: `ai_voice` is Beta (default OFF), sourced from `salons.voice_ai_enabled`.
  // notFound() here is server-side — direct URL access is refused, not just hidden.
  if (!isReleaseFeatureEnabled(r, "ai_voice")) {
    notFound();
  }

  const initial: VoiceAiSettingsInput = {
    voice_ai_enabled:          r.voice_ai_enabled          ?? false,
    voice_ai_persona_name:     r.voice_ai_persona_name      ?? "Lily",
    voice_ai_persona_voice:    r.voice_ai_persona_voice     ?? "marin",
    voice_ai_reasoning_effort: r.voice_ai_reasoning_effort  ?? "low",
  };

  // Build the Twilio Voice webhook URL from the SAME base the inbound route
  // (src/app/api/twilio/voice) validates Twilio's signature against — a URL from
  // any other origin would fail signature verification when pasted into Twilio.
  const webhookBase = (process.env.NEXT_PUBLIC_APP_URL ?? "https://nailiq.ca").replace(/\/$/, "");
  const webhookUrl = `${webhookBase}/api/twilio/voice?slug=${encodeURIComponent(slug)}`;

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <h1 className="mb-6 text-xl font-bold">Voice AI Settings</h1>
      <VoiceSettingsForm slug={slug} initial={initial} />
      <VoicePhoneSetup
        webhookUrl={webhookUrl}
        enabled={initial.voice_ai_enabled}
        sessionsUsed={r.voice_ai_sessions_this_month ?? 0}
        sessionsLimit={r.voice_ai_sessions_limit ?? 200}
        resetAt={r.voice_ai_sessions_reset_at ?? null}
      />
    </div>
  );
}
