"use client";

import { useState, useTransition } from "react";
import { updateVoiceAiPersonaName } from "@/shared/dashboard/salonOwnerActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { getUserMessages } from "@/shared/i18n/user";

type Props = {
  slug: string;
  initialName: string;
};

export function VoiceAiSettings({ slug, initialName }: Props) {
  const { language } = useUserLanguage();
  const t = getUserMessages(language);
  const [name, setName] = useState(initialName || "Lily");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateVoiceAiPersonaName(slug, name);
      if (result.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      } else {
        setError(
          result.error === "invalid_name"
            ? t.salonSettings.voiceAiSave.invalidName
            : result.error === "forbidden"
              ? t.salonSettings.voiceAiSave.forbidden
              : t.salonSettings.voiceAiSave.saveError,
        );
      }
    });
  }

  return (
    <section
      data-testid="settings-voice-ai"
      className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
    >
      <div className="flex items-center gap-2">
        <p className="text-sm font-semibold text-nq-foreground">Lễ tân ảo</p>
        <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
          AI
        </span>
      </div>
      <p className="mt-0.5 text-xs text-nq-muted">
        Đặt tên riêng cho lễ tân ảo — khách sẽ nghe tên này khi gọi đặt lịch. Mặc định là <strong className="text-nq-foreground">Lily</strong>.
      </p>
      <div className="mt-3 flex flex-col gap-2">
        <input
          type="text"
          maxLength={40}
          placeholder="Lily"
          value={name}
          disabled={isPending}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-xl border border-nq-border/40 bg-nq-surface/60 px-3 py-2.5 text-sm text-nq-foreground placeholder:text-nq-muted/60 focus:border-nq-primary/40 focus:outline-none focus:ring-1 focus:ring-nq-primary/30 disabled:opacity-50"
        />
        {error ? (
          <p className="text-xs text-nq-error">{error}</p>
        ) : null}
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={isPending || !name.trim()}
            onClick={handleSave}
            className="rounded-xl border border-nq-primary/40 bg-nq-primary/10 px-3 py-1.5 text-xs font-semibold text-nq-primary transition hover:bg-nq-primary/15 disabled:opacity-50"
          >
            {isPending ? t.salonSettings.voiceAiSave.saving : t.salonSettings.voiceAiSave.save}
          </button>
          {saved ? (
            <span className="text-xs text-nq-success">{t.salonSettings.voiceAiSave.saved}</span>
          ) : null}
        </div>
      </div>
    </section>
  );
}
