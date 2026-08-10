"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarPlus, ChevronDown, UserPlus, Users } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { cn } from "@/shared/lib/cn";

type Props = {
  language: "en" | "vi";
  canAddWalkin: boolean;
  canAddAppointment: boolean;
  canAddGroup: boolean;
  onAddWalkin: () => void;
  onAddAppointment: () => void;
  onAddGroup: () => void;
};

/**
 * A single, calm creation entry point for the front desk.
 *
 * The existing forms and server actions remain unchanged; this component only
 * replaces three competing header buttons with one progressive-disclosure menu.
 */
export function ReceptionistCreateMenu({
  language,
  canAddWalkin,
  canAddAppointment,
  canAddGroup,
  onAddWalkin,
  onAddAppointment,
  onAddGroup,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const vi = language === "vi";

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  if (!canAddWalkin && !canAddAppointment && !canAddGroup) return null;

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div ref={rootRef} className="relative" data-testid="receptionist-create-menu">
      <Button
        type="button"
        variant="primary"
        size="sm"
        className="min-h-11 px-4 text-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="receptionist-create-trigger"
        onClick={() => setOpen((current) => !current)}
      >
        {vi ? "+ Tạo" : "+ Create"}
        <ChevronDown
          className={cn(
            "ml-1 h-4 w-4 transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </Button>

      {open ? (
        <div
          role="menu"
          aria-label={vi ? "Chọn nội dung cần tạo" : "Choose what to create"}
          className="absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-xl border border-nq-border bg-nq-surface p-1.5 shadow-nq-card"
        >
          {canAddWalkin ? (
            <MenuItem
              icon={UserPlus}
              label={vi ? "Khách vãng lai" : "Walk-in"}
              hint={vi ? "Thêm vào hàng chờ hôm nay" : "Add to today's queue"}
              testId="create-menu-walkin"
              onClick={() => run(onAddWalkin)}
            />
          ) : null}
          {canAddAppointment ? (
            <MenuItem
              icon={CalendarPlus}
              label={vi ? "Lịch hẹn" : "Appointment"}
              hint={vi ? "Đặt hẹn qua điện thoại" : "Book a phone-in guest"}
              testId="create-menu-appointment"
              onClick={() => run(onAddAppointment)}
            />
          ) : null}
          {canAddGroup ? (
            <MenuItem
              icon={Users}
              label={vi ? "Lịch nhóm" : "Group booking"}
              hint={vi ? "Tạo lịch cho nhiều khách" : "Book multiple guests"}
              testId="create-menu-group"
              onClick={() => run(onAddGroup)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  hint,
  testId,
  onClick,
}: {
  icon: typeof UserPlus;
  label: string;
  hint: string;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-nq-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/50"
      onClick={onClick}
    >
      <Icon className="h-5 w-5 shrink-0 text-nq-primary" aria-hidden />
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-nq-foreground">
          {label}
        </span>
        <span className="block truncate text-xs text-nq-muted">{hint}</span>
      </span>
    </button>
  );
}
