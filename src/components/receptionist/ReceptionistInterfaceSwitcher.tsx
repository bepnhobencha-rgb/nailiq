"use client";

import { LayoutDashboard, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/Button";
import type { ReceptionistInterface } from "@/shared/dashboard/useReceptionistInterface";

export type ReceptionistInterfaceSwitcherProps = {
  value: ReceptionistInterface;
  language: "en" | "vi";
  onChange: (next: ReceptionistInterface) => void;
  className?: string;
};

export function ReceptionistInterfaceSwitcher({
  value,
  language,
  onChange,
  className,
}: ReceptionistInterfaceSwitcherProps) {
  const isPreview = value === "preview";
  const next: ReceptionistInterface = isPreview ? "classic" : "preview";
  const label = isPreview
    ? language === "vi"
      ? "Cổ điển"
      : "Classic"
    : language === "vi"
      ? "Mới · Xem trước"
      : "New · Preview";
  const ariaLabel = isPreview
    ? language === "vi"
      ? "Quay lại giao diện cổ điển"
      : "Return to the classic interface"
    : language === "vi"
      ? "Dùng thử giao diện Tiếp Tân mới"
      : "Try the new Receptionist interface";

  return (
    <Button
      variant="secondary"
      size="sm"
      data-testid="receptionist-interface-switcher"
      aria-label={ariaLabel}
      aria-pressed={isPreview}
      leftIcon={
        isPreview ? (
          <LayoutDashboard className="h-4 w-4" />
        ) : (
          <Sparkles className="h-4 w-4" />
        )
      }
      onClick={() => onChange(next)}
      className={className}
    >
      {label}
    </Button>
  );
}
