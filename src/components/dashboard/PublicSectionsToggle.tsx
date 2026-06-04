"use client";

import { useState, useTransition } from "react";
import { updatePublicSectionsEnabled } from "@/shared/dashboard/pageEditorActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Props = {
  slug: string;
  initialEnabled: boolean;
};

/**
 * Owner toggle: publish the visible website sections onto the public booking
 * page. Off by default so a salon's public page never changes until they
 * explicitly turn it on.
 */
export function PublicSectionsToggle({ slug, initialEnabled }: Props) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const [on, setOn] = useState(initialEnabled);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !on;
    setOn(next);
    startTransition(async () => {
      const res = await updatePublicSectionsEnabled(slug, next);
      if (!res.ok) setOn(!next); // revert on failure
    });
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={pending}
      onClick={toggle}
      data-testid="publish-sections-toggle"
      className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm font-medium text-[#a1a1aa] transition-colors hover:border-white/20 hover:text-white disabled:opacity-50"
    >
      <span
        aria-hidden
        className={`relative h-5 w-9 rounded-full transition-colors ${on ? "bg-[#D4AF37]" : "bg-white/15"}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${on ? "translate-x-4" : "translate-x-0.5"}`}
        />
      </span>
      {on
        ? vi
          ? "Đang hiển thị trên web"
          : "Live on site"
        : vi
          ? "Hiển thị trên web"
          : "Publish to site"}
    </button>
  );
}
