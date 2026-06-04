"use client";

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SetupToast, type SetupToastPayload } from "@/components/ui/Toast";
import { cn } from "@/shared/lib/cn";
import {
  deleteStaff,
  updateStaff,
  type StaffJobRole,
  type StaffStatus,
} from "@/shared/dashboard/setupActions";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

// StaffDrawer is being built in parallel — import by interface contract
import { StaffDrawer } from "@/components/dashboard/StaffDrawer";
import { StaffAccessControl } from "@/components/dashboard/StaffAccessControl";
import type { StaffAccessInfo } from "@/shared/dashboard/staffAccess";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SetupStaffRow = {
  id: string;
  name: string;
  job_role: StaffJobRole;
  /** B-03: 'active' rows go public; 'pending' / 'inactive' stay dashboard-only. */
  status: StaffStatus;
};

export type SetupStaffServiceOption = {
  id: string;
  name: string;
};

// ── Constants (exported so StaffDrawer can import) ─────────────────────────────

/** P1.8 — role labels are now localized via `setupStaff.roleOptions`.
 * Only the enum order is fixed here; labels resolve at render time so
 * VI sees "Chủ tiệm / Thợ chính / Thợ phụ" while EN keeps the English
 * names. */
export const ROLE_VALUES: readonly StaffJobRole[] = [
  "owner",
  "senior",
  "nail_tech",
] as const;

export const STATUS_VALUES: readonly StaffStatus[] = [
  "active",
  "pending",
  "inactive",
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

const ROLE_ICONS: Record<string, string> = {
  owner: "👑",
  senior: "⭐",
  nail_tech: "💅",
};

function getRoleIcon(role: string): string {
  return ROLE_ICONS[role] ?? "👤";
}

const TOAST_ERR = "✗ Could not save. Check your connection.";
const UNDO_TIMEOUT_MS = 5000;

function mapDeleteStaffError(
  code: string,
  setupErrors: { staffHasBookings: string },
): string {
  if (code === "minimum_staff") {
    return "You need more than one staff member before you can remove someone.";
  }
  if (code === "staff_has_bookings" || code === "in_use") {
    return setupErrors.staffHasBookings;
  }
  return "Could not remove. Try again.";
}

// ── ServicesCheckboxList (exported so StaffDrawer can import) ──────────────────

export function ServicesCheckboxList({
  services,
  selectedIds,
  disabled,
  label,
  hint,
  emptyLabel,
  onChange,
}: {
  services: SetupStaffServiceOption[];
  selectedIds: string[];
  disabled: boolean;
  label: string;
  hint: string;
  emptyLabel: string;
  onChange: (next: string[]) => void;
}) {
  const selectedSet = new Set(selectedIds);

  if (services.length === 0) {
    return (
      <p className="text-sm text-nq-muted" role="note">
        {emptyLabel}
      </p>
    );
  }

  return (
    <fieldset className="block">
      <legend className="text-sm font-medium text-nq-muted">{label}</legend>
      <p className="mt-1 text-xs text-nq-muted/80">{hint}</p>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {services.map((s) => {
          const checked = selectedSet.has(s.id);
          return (
            <label
              key={s.id}
              className="flex min-h-11 items-center gap-2 rounded-xl border border-nq-border/40 bg-nq-bg/85 px-3 py-2 text-sm text-nq-foreground"
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(e) => {
                  const next = new Set(selectedIds);
                  if (e.target.checked) {
                    next.add(s.id);
                  } else {
                    next.delete(s.id);
                  }
                  onChange(Array.from(next));
                }}
              />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// ── StatusBadge — compact inline chip ─────────────────────────────────────────

function StatusBadge({
  status,
  pendingLabel,
  inactiveLabel,
}: {
  status: StaffStatus;
  pendingLabel: string;
  inactiveLabel: string;
}) {
  if (status === "active") return null;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold",
        status === "pending"
          ? "border-nq-warning/45 bg-nq-warning/12 text-nq-warning"
          : "border-nq-muted/40 bg-nq-muted/10 text-nq-muted",
      )}
      aria-label={status === "pending" ? pendingLabel : inactiveLabel}
      data-testid={`staff-status-badge-${status}`}
    >
      {status === "pending" ? pendingLabel : inactiveLabel}
    </span>
  );
}

// ── StaffCompactRow ────────────────────────────────────────────────────────────

function StaffCompactRow({
  row,
  roleLabel,
  pendingLabel,
  inactiveLabel,
  isLast,
  pendingId,
  canDelete,
  onEdit,
  onDelete,
}: {
  row: SetupStaffRow;
  roleLabel: string;
  pendingLabel: string;
  inactiveLabel: string;
  isLast: boolean;
  pendingId: string | null;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isPending = pendingId === row.id;

  return (
    <div
      className={cn(
        "flex min-h-[52px] items-center gap-3 px-0 py-3 transition-colors",
        !isLast && "border-b border-nq-border/20",
      )}
    >
      {/* Role icon */}
      <span
        aria-hidden
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-nq-primary/10 text-sm"
      >
        {getRoleIcon(row.job_role)}
      </span>

      {/* Name */}
      <span className="flex-1 truncate text-sm font-medium text-nq-foreground">
        {row.name}
      </span>

      {/* Role label + status badge */}
      <div className="flex shrink-0 items-center gap-1.5">
        <span className="text-xs text-nq-muted">{roleLabel}</span>
        <StatusBadge
          status={row.status}
          pendingLabel={pendingLabel}
          inactiveLabel={inactiveLabel}
        />
      </div>

      {/* Edit button */}
      <button
        type="button"
        title="Chỉnh sửa"
        aria-label={`Chỉnh sửa ${row.name}`}
        disabled={pendingId !== null}
        className="shrink-0 rounded-lg p-1.5 text-nq-muted transition-colors hover:bg-nq-surface hover:text-nq-foreground disabled:opacity-50"
        onClick={onEdit}
      >
        {isPending ? (
          <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
        ) : (
          "✏️"
        )}
      </button>

      {/* Delete button */}
      <button
        type="button"
        title="Xoá"
        aria-label={`Xoá ${row.name}`}
        disabled={pendingId !== null || !canDelete}
        className="shrink-0 rounded-lg p-1.5 text-nq-muted transition-colors hover:bg-nq-error/10 hover:text-nq-error disabled:opacity-50"
        onClick={onDelete}
      >
        🗑️
      </button>
    </div>
  );
}

// ── StaffSetupPanel ────────────────────────────────────────────────────────────

export function StaffSetupPanel({
  slug,
  initialRows,
  services,
  initialServiceIdsByStaff,
  salonHasCapabilityRows,
  maxStaff,
  accessByStaff,
  currentUserRole,
}: {
  slug: string;
  initialRows: SetupStaffRow[];
  services: SetupStaffServiceOption[];
  /** staffId → service IDs already attached. */
  initialServiceIdsByStaff: Record<string, string[]>;
  /** staffId → login/permission info, or null when booking-only (no login). */
  accessByStaff: Record<string, StaffAccessInfo | null>;
  /** Caller's own salon_members role — gates who can grant `admin`. */
  currentUserRole: string;
  /** When false, the salon is in the all-capable fallback; checkboxes are pre-checked
   *  so the first save does not accidentally narrow capability. */
  salonHasCapabilityRows: boolean;
  /** Server-resolved cap (from `getEffectivePlanLimits`). `Infinity`
   *  for unlimited plans / feature-flag overrides. Server still
   *  re-validates on every `addStaff` call. */
  maxStaff: number;
}) {
  const { language } = useUserLanguage();
  const messages = getUserMessages(language);
  const setupErrors = messages.setupErrors;
  const setupStaffCopy = messages.setupStaff;
  const tLabels = messages.setupLabels;
  const router = useRouter();

  const [rows, setRows] = useState(initialRows);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [toast, setToast] = useState<SetupToastPayload | null>(null);
  const [search, setSearch] = useState("");

  // Drawer state
  const [drawerStaff, setDrawerStaff] = useState<SetupStaffRow | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Undo-delete state
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [undoPending, setUndoPending] = useState<{
    row: SetupStaffRow;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  // Sync rows from server
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- server list after refresh
    setRows(initialRows);
  }, [initialRows]);

  const refresh = useCallback(() => router.refresh(), [router]);

  // Any mutation in flight
  const isMutating = pendingId !== null;

  // Plan-cap gate (UX only — server re-validates)
  const atStaffLimit =
    Number.isFinite(maxStaff) && rows.length >= maxStaff;

  // ── handleUpdate (unchanged logic) ────────────────────────────────────────────
  const handleUpdate = useCallback(
    async (
      staffId: string,
      patch: Partial<Pick<SetupStaffRow, "name" | "job_role" | "status">> & {
        serviceIds?: string[];
      },
    ) => {
      setFormError(null);
      setPendingId(staffId);
      let res: Awaited<ReturnType<typeof updateStaff>>;
      try {
        res = await updateStaff(slug, staffId, {
          name: patch.name,
          role: patch.job_role,
          status: patch.status,
          serviceIds: patch.serviceIds,
        });
      } catch (err) {
        Sentry.captureMessage("[StaffSetupPanel] updateStaff threw", {
          level: "error",
          tags: { "salon.action": "update_staff", "salon.slug": slug },
          extra: { staffId, patch, error: String(err) },
        });
        setPendingId(null);
        setFormError("Could not save changes. Try again.");
        setToast({ variant: "error", message: TOAST_ERR });
        return;
      }
      setPendingId(null);
      if (!res.ok) {
        setFormError("Could not save changes. Try again.");
        setToast({ variant: "error", message: TOAST_ERR });
        return;
      }
      setRows((prev) =>
        prev.map((r) =>
          r.id === staffId
            ? {
                ...r,
                name: patch.name ?? r.name,
                job_role: patch.job_role ?? r.job_role,
                status: patch.status ?? r.status,
              }
            : r,
        ),
      );
      setToast({ variant: "success", message: tLabels.staffSaved });
      refresh();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tLabels.staffSaved is a message string that doesn't change within a session
    [refresh, slug],
  );

  // ── handleDeleteOptimistic — optimistic remove + undo window ──────────────────
  const handleDeleteOptimistic = useCallback(
    (staffId: string) => {
      // Clear any previous undo timer
      if (undoTimerRef.current !== null) {
        clearTimeout(undoTimerRef.current);
        undoTimerRef.current = null;
      }
      // If there was a previous undo pending that hasn't fired yet,
      // commit the real delete immediately for that row
      if (undoPending !== null) {
        const prevId = undoPending.row.id;
        void deleteStaff(slug, prevId).catch(() => {
          // Best-effort: if this fails we accept the ghost row
        });
      }

      const rowToDelete = rows.find((r) => r.id === staffId);
      if (!rowToDelete) return;

      // Optimistically remove from UI
      setRows((prev) => prev.filter((r) => r.id !== staffId));

      // Set up undo window
      const timer = setTimeout(async () => {
        setUndoPending(null);
        undoTimerRef.current = null;
        // Commit the real delete
        setFormError(null);
        setPendingId(staffId);
        let res: Awaited<ReturnType<typeof deleteStaff>>;
        try {
          res = await deleteStaff(slug, staffId);
        } catch (err) {
          Sentry.captureMessage("[StaffSetupPanel] deleteStaff threw", {
            level: "error",
            tags: { "salon.action": "delete_staff", "salon.slug": slug },
            extra: { staffId, error: String(err) },
          });
          setPendingId(null);
          // Restore the row on error
          setRows((prev) => [...prev, rowToDelete]);
          setFormError("Could not remove. Try again.");
          setToast({ variant: "error", message: TOAST_ERR });
          return;
        }
        setPendingId(null);
        if (!res.ok) {
          setFormError(mapDeleteStaffError(res.error, setupErrors));
          setToast({ variant: "error", message: TOAST_ERR });
          // Restore the row on server-side error
          setRows((prev) => [...prev, rowToDelete]);
          return;
        }
        setToast({ variant: "success", message: tLabels.staffRemoved });
        refresh();
      }, UNDO_TIMEOUT_MS);

      undoTimerRef.current = timer;
      setUndoPending({ row: rowToDelete, timer });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tLabels.staffRemoved is a message string that doesn't change within a session
    [rows, undoPending, slug, setupErrors, refresh],
  );

  const handleUndoDelete = useCallback(() => {
    if (undoPending === null) return;
    clearTimeout(undoPending.timer);
    undoTimerRef.current = null;
    // Restore the row
    setRows((prev) => [...prev, undoPending.row]);
    setUndoPending(null);
  }, [undoPending]);

  // Cleanup timer on unmount
  useEffect(
    () => () => {
      if (undoTimerRef.current !== null) clearTimeout(undoTimerRef.current);
    },
    [],
  );

  // ── Filtered rows ──────────────────────────────────────────────────────────────
  const filteredRows = rows.filter((r) =>
    r.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="flex flex-col gap-4">
      <SetupToast toast={toast} onDismiss={() => setToast(null)} />

      {formError ? (
        <p className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error">
          {formError}
        </p>
      ) : null}

      {/* ── Header row: title + "Thêm" button ────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-nq-foreground">
          {tLabels.staffTitle} · {rows.length}
        </h2>
        <Button
          variant="primary"
          size="sm"
          disabled={atStaffLimit || isMutating}
          onClick={() => {
            setDrawerStaff(null);
            setDrawerOpen(true);
          }}
        >
          + {tLabels.addStaff}
        </Button>
      </div>

      {/* Plan-limit banner */}
      {atStaffLimit ? (
        <p
          className="rounded-xl border border-nq-primary/30 bg-nq-primary/10 px-3 py-2 text-sm text-nq-foreground"
          role="status"
          data-testid="staff-at-limit-banner"
        >
          {setupErrors.staffLimitReached}{" "}
          <Link
            href={`/dashboard/${encodeURIComponent(slug)}/settings`}
            className="font-semibold text-nq-primary underline-offset-2 hover:text-nq-primary/85 hover:underline"
            data-testid="staff-at-limit-upgrade-link"
          >
            {setupErrors.upgradeCta}
          </Link>
        </p>
      ) : null}

      {/* ── Search bar ────────────────────────────────────────────────────────── */}
      {rows.length > 0 && (
        <input
          type="search"
          placeholder={`🔍 ${tLabels.searchStaff}`}
          className="w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-4 py-2.5 text-base text-nq-foreground outline-none focus-visible:border-nq-primary/75"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}

      {/* ── Staff compact list ────────────────────────────────────────────────── */}
      {filteredRows.length === 0 && rows.length > 0 ? (
        <p className="py-6 text-center text-sm text-nq-muted">
          Không tìm thấy nhân viên nào.
        </p>
      ) : (
        <div className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-4">
          {filteredRows.map((row, idx) => {
            const isLast = idx === filteredRows.length - 1;
            return (
              <div
                key={row.id}
                className={cn(!isLast && "border-b border-nq-border/20")}
              >
                <StaffCompactRow
                  row={row}
                  roleLabel={setupStaffCopy.roleOptions[row.job_role]}
                  pendingLabel={setupStaffCopy.pendingBadge}
                  inactiveLabel={setupStaffCopy.inactiveBadge}
                  isLast
                  pendingId={pendingId}
                  canDelete={rows.length > 1}
                  onEdit={() => {
                    setDrawerStaff(row);
                    setDrawerOpen(true);
                  }}
                  onDelete={() => handleDeleteOptimistic(row.id)}
                />
                <StaffAccessControl
                  slug={slug}
                  staffId={row.id}
                  access={accessByStaff[row.id] ?? null}
                  currentUserRole={currentUserRole}
                  onToast={(message, kind) =>
                    setToast({ variant: kind, message })
                  }
                />
              </div>
            );
          })}
        </div>
      )}

      {/* ── Undo delete toast ─────────────────────────────────────────────────── */}
      {undoPending && (
        <div className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-nq-border/50 bg-nq-surface px-4 py-2.5 shadow-lg text-sm">
          <span>
            Đã xoá <strong>{undoPending.row.name}</strong>
          </span>
          <button
            type="button"
            onClick={handleUndoDelete}
            className="font-semibold text-nq-primary"
          >
            ↺ Hoàn tác
          </button>
        </div>
      )}

      {/* ── StaffDrawer (add + edit) ──────────────────────────────────────────── */}
      <StaffDrawer
        slug={slug}
        staff={drawerStaff}
        services={services}
        initialServiceIds={
          drawerStaff
            ? salonHasCapabilityRows
              ? (initialServiceIdsByStaff[drawerStaff.id] ?? [])
              : services.map((s) => s.id)
            : []
        }
        salonHasCapabilityRows={salonHasCapabilityRows}
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSaved={(updated) => {
          setRows((prev) =>
            prev.map((r) => (r.id === updated.id ? updated : r)),
          );
          setDrawerOpen(false);
          setToast({ variant: "success", message: tLabels.staffSaved });
        }}
        onAdded={() => {
          refresh();
          setDrawerOpen(false);
          setToast({ variant: "success", message: tLabels.staffSaved });
        }}
        onRequestDelete={(id) => {
          setDrawerOpen(false);
          handleDeleteOptimistic(id);
        }}
        canDelete={rows.length > 1}
        atStaffLimit={atStaffLimit}
      />
    </div>
  );
}
