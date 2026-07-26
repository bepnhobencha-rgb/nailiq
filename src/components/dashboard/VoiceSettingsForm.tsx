"use client";

import { useState, useTransition } from "react";
import {
  updateVoiceAiSettings,
  type VoiceAiSettingsInput,
} from "@/shared/dashboard/setupActions";

// OpenAI GA Realtime voices. Marin/Cedar are the newest, most natural pair.
const VOICES = [
  { value: "marin",   label: "Marin — female (newest, default)" },
  { value: "coral",   label: "Coral — female, warm" },
  { value: "shimmer", label: "Shimmer — female, bright" },
  { value: "sage",    label: "Sage — female, soft" },
  { value: "cedar",   label: "Cedar — male (newest)" },
  { value: "ash",     label: "Ash — male, deep" },
  { value: "echo",    label: "Echo — male" },
  { value: "ballad",  label: "Ballad — male" },
  { value: "alloy",   label: "Alloy — neutral" },
  { value: "verse",   label: "Verse — neutral" },
] as const;

const EFFORTS = [
  { value: "low",    label: "Low (fast, cheaper)" },
  { value: "medium", label: "Medium (balanced)" },
  { value: "high",   label: "High (smarter)" },
] as const;

type Props = {
  slug: string;
  initial: VoiceAiSettingsInput;
};

export function VoiceSettingsForm({ slug, initial }: Props) {
  const [form, setForm] = useState<VoiceAiSettingsInput>(initial);
  const [saved, setSaved] = useState(false);
  const [err, setErr]     = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleChange<K extends keyof VoiceAiSettingsInput>(key: K, val: VoiceAiSettingsInput[K]) {
    setForm((prev) => ({ ...prev, [key]: val }));
    setSaved(false);
    setErr(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await updateVoiceAiSettings(slug, form);
      if ("error" in res) setErr(res.error);
      else setSaved(true);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Enable toggle */}
      <div className="flex items-center justify-between rounded-2xl border border-[var(--color-border)] p-4">
        <div>
          <p className="font-semibold">Enable Voice AI</p>
          <p className="text-sm text-[var(--color-text-muted)]">Show voice booking button on your public booking page</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={form.voice_ai_enabled}
          onClick={() => handleChange("voice_ai_enabled", !form.voice_ai_enabled)}
          className={[
            "relative inline-flex h-7 w-12 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200",
            form.voice_ai_enabled ? "bg-[var(--color-primary)]" : "bg-zinc-300",
          ].join(" ")}
        >
          <span
            className={[
              "pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200",
              form.voice_ai_enabled ? "translate-x-5" : "translate-x-0",
            ].join(" ")}
          />
        </button>
      </div>

      {/* Upsell toggle */}
      <div className="flex items-center justify-between rounded-2xl border border-[var(--color-border)] p-4">
        <div>
          <p className="font-semibold">Suggest upgrades &amp; add-ons</p>
          <p className="text-sm text-[var(--color-text-muted)]">After a service is chosen, the receptionist offers one tasteful upsell (e.g. add a pedicure, upgrade to shellac)</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={form.voice_ai_upsell_enabled}
          onClick={() => handleChange("voice_ai_upsell_enabled", !form.voice_ai_upsell_enabled)}
          className={[
            "relative inline-flex h-7 w-12 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200",
            form.voice_ai_upsell_enabled ? "bg-[var(--color-primary)]" : "bg-zinc-300",
          ].join(" ")}
        >
          <span
            className={[
              "pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200",
              form.voice_ai_upsell_enabled ? "translate-x-5" : "translate-x-0",
            ].join(" ")}
          />
        </button>
      </div>

      {/* Persona name */}
      <div className="space-y-1.5">
        <label className="text-sm font-semibold" htmlFor="persona-name">AI Persona Name</label>
        <input
          id="persona-name"
          type="text"
          value={form.voice_ai_persona_name}
          onChange={(e) => handleChange("voice_ai_persona_name", e.target.value)}
          maxLength={40}
          placeholder="Lily"
          className="w-full rounded-xl border border-[var(--color-border)] bg-transparent px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
        />
      </div>

      {/* Voice selector */}
      <div className="space-y-1.5">
        <label className="text-sm font-semibold" htmlFor="voice-select">Voice</label>
        <select
          id="voice-select"
          value={form.voice_ai_persona_voice}
          onChange={(e) => handleChange("voice_ai_persona_voice", e.target.value)}
          className="w-full rounded-xl border border-[var(--color-border)] bg-transparent px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
        >
          {VOICES.map((v) => (
            <option key={v.value} value={v.value}>{v.label}</option>
          ))}
        </select>
      </div>

      {/* Reasoning effort */}
      <div className="space-y-1.5">
        <label className="text-sm font-semibold" htmlFor="effort-select">Reasoning Effort</label>
        <select
          id="effort-select"
          value={form.voice_ai_reasoning_effort}
          onChange={(e) => handleChange("voice_ai_reasoning_effort", e.target.value)}
          className="w-full rounded-xl border border-[var(--color-border)] bg-transparent px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
        >
          {EFFORTS.map((ef) => (
            <option key={ef.value} value={ef.value}>{ef.label}</option>
          ))}
        </select>
      </div>

      {/* Live human handoff */}
      <div className="space-y-1.5">
        <label className="text-sm font-semibold" htmlFor="transfer-phone">
          Human transfer phone
        </label>
        <input
          id="transfer-phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={form.voice_ai_transfer_phone}
          onChange={(e) => handleChange("voice_ai_transfer_phone", e.target.value)}
          placeholder="+1 604 555 0123"
          className="w-full rounded-xl border border-[var(--color-border)] bg-transparent px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
        />
        <p className="text-sm text-[var(--color-text-muted)]">
          Optional. The receptionist transfers here when a caller asks for a person
          or needs help outside its tools. Use a different number from the AI line.
        </p>
      </div>

      {saved && (
        <p className="rounded-xl bg-green-50 px-4 py-3 text-sm font-semibold text-green-700">
          ✓ Settings saved
        </p>
      )}
      {err && (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{err}</p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-2xl bg-[var(--color-primary)] py-3.5 text-sm font-semibold text-white disabled:opacity-60 hover:opacity-90 transition-opacity"
      >
        {isPending ? "Saving…" : "Save Voice Settings"}
      </button>
    </form>
  );
}
