"use client";

import { useTransition } from "react";
import { signOutAction } from "@/shared/dashboard/salonOwnerActions";
import { cn } from "@/shared/lib/cn";

const COPY = {
  en: {
    label: "Sign out",
    confirm: "Are you sure you want to sign out?",
  },
  vi: {
    label: "Đăng xuất",
    confirm: "Bạn có chắc muốn đăng xuất?",
  },
} as const;

type Props = {
  language: "en" | "vi";
};

export function LogoutButton({ language }: Props) {
  const [pending, startTransition] = useTransition();
  const t = COPY[language];

  const onClick = () => {
    if (typeof window !== "undefined") {
      const confirmed = window.confirm(t.confirm);
      if (!confirmed) return;
    }
    startTransition(async () => {
      await signOutAction();
    });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      aria-busy={pending || undefined}
      className={cn(
        "inline-flex min-h-9 touch-manipulation items-center gap-1.5 rounded-lg border border-nq-border/45 bg-nq-surface/45 px-2.5 py-1 text-xs font-medium text-nq-muted transition-colors",
        "hover:bg-nq-surface/65 hover:text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45",
        "disabled:cursor-not-allowed disabled:opacity-55",
      )}
    >
      <span aria-hidden className="text-base leading-none">
        →
      </span>
      {t.label}
    </button>
  );
}
