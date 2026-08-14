"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SetupToast, type SetupToastPayload } from "@/components/ui/Toast";
import { cn } from "@/shared/lib/cn";
import {
  type StaffJobRole,
  type StaffStatus,
} from "@/shared/dashboard/setupActions";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

// StaffDrawer is being built in parallel — import by interface contract
import { StaffDrawer } from "@/components/dashboard/StaffDrawer";
import { StaffAccessControl } from "@/components/dashboard/StaffAccessControl";
import { AddTeamMemberSheet } from "@/components/dashboard/AddTeamMemberSheet";
import type { StaffAccessInfo } from "@/shared/dashboard/staffAccess";
import { StaffOffboardingDrawer } from "@/components/dashboard/StaffOffboardingDrawer";

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
  canDelete,
  editLabel,
  removeLabel,
  onEdit,
  onDelete,
}: {
  row: SetupStaffRow;
  roleLabel: string;
  pendingLabel: string;
  inactiveLabel: string;
  isLast: boolean;
  canDelete: boolean;
  editLabel: string;
  removeLabel: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
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
        title={editLabel}
        aria-label={`${editLabel} — ${row.name}`}
        data-testid={`staff-edit-${row.id}`}
        className="shrink-0 rounded-lg p-1.5 text-nq-muted transition-colors hover:bg-nq-surface hover:text-nq-foreground disabled:opacity-50"
        onClick={onEdit}
      >
        ✏️
      </button>

      {/* Delete button */}
      <button
        type="button"
        title={removeLabel}
        aria-label={`${removeLabel} — ${row.name}`}
        data-testid={`staff-delete-${row.id}`}
        disabled={!canDelete}
        className="shrink-0 rounded-lg p-1.5 text-nq-muted transition-colors hover:bg-nq-error/10 hover:text-nq-error disabled:opacity-50"
        onClick={onDelete}
      >
        🚪
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
  salonCapabilityConfigured,
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
  /** When false, the salon is in the durable legacy-all mode; checkboxes are
   *  pre-checked so the first save does not accidentally narrow capability. */
  salonCapabilityConfigured: boolean;
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
  const [capabilityConfigured, setCapabilityConfigured] = useState(
    salonCapabilityConfigured,
  );
  const [serviceIdsByStaff, setServiceIdsByStaff] = useState(
    initialServiceIdsByStaff,
  );
  const [toast, setToast] = useState<SetupToastPayload | null>(null);
  const [search, setSearch] = useState("");

  // Drawer state (edit existing staff)
  const [drawerStaff, setDrawerStaff] = useState<SetupStaffRow | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // All-in-one "Add team member" sheet (create staff + optional login at once)
  const [addSheetOpen, setAddSheetOpen] = useState(false);

  // Safe offboarding assistant. This replaces destructive optimistic delete:
  // bookings are reassigned first and the profile remains for audit/history.
  const [offboardingStaffId, setOffboardingStaffId] = useState<string | null>(null);
  const [offboardingOpen, setOffboardingOpen] = useState(false);

  // Sync rows from server
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- server list after refresh
    setRows(initialRows);
  }, [initialRows]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- server capability state after refresh
    setCapabilityConfigured(salonCapabilityConfigured);
    setServiceIdsByStaff(initialServiceIdsByStaff);
  }, [initialServiceIdsByStaff, salonCapabilityConfigured]);

  const refresh = useCallback(() => router.refresh(), [router]);

  // Plan-cap gate (UX only — server re-validates)
  const atStaffLimit =
    Number.isFinite(maxStaff) && rows.length >= maxStaff;

  const openOffboarding = useCallback((staffId: string) => {
    setDrawerOpen(false);
    setOffboardingStaffId(staffId);
    setOffboardingOpen(true);
  }, []);

  // ── Filtered rows ──────────────────────────────────────────────────────────────
  const filteredRows = rows.filter((r) =>
    r.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="flex flex-col gap-4">
      <SetupToast toast={toast} onDismiss={() => setToast(null)} />

      {/* ── Header row: title + "Thêm" button ────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-nq-foreground">
          {tLabels.staffTitle} · {rows.length}
        </h2>
        <Button
          variant="primary"
          size="sm"
          disabled={atStaffLimit}
          onClick={() => setAddSheetOpen(true)}
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
                  canDelete={rows.length > 1 && row.status === "active"}
                  editLabel={tLabels.editStaff}
                  removeLabel={tLabels.removeStaff}
                  onEdit={() => {
                    setDrawerStaff(row);
                    setDrawerOpen(true);
                  }}
                  onDelete={() => openOffboarding(row.id)}
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

      {/* ── StaffDrawer (add + edit) ──────────────────────────────────────────── */}
      <StaffDrawer
        slug={slug}
        staff={drawerStaff}
        services={services}
        initialServiceIds={
          drawerStaff
            ? capabilityConfigured
              ? (serviceIdsByStaff[drawerStaff.id] ?? [])
              : services.map((s) => s.id)
            : []
        }
        salonCapabilityConfigured={capabilityConfigured}
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSaved={(updated, savedServiceIds, savedCapabilityConfigured) => {
          setRows((prev) =>
            prev.map((r) => (r.id === updated.id ? updated : r)),
          );
          setServiceIdsByStaff((current) => ({
            ...(!capabilityConfigured && savedCapabilityConfigured
              ? Object.fromEntries(
                  rows.map((row) => [
                    row.id,
                    services.map((service) => service.id),
                  ]),
                )
              : current),
            [updated.id]: savedServiceIds,
          }));
          setCapabilityConfigured(savedCapabilityConfigured);
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
          openOffboarding(id);
        }}
        canDelete={rows.length > 1 && drawerStaff?.status === "active"}
        atStaffLimit={atStaffLimit}
      />

      <StaffOffboardingDrawer
        key={`${offboardingStaffId ?? "none"}-${offboardingOpen ? "open" : "closed"}`}
        slug={slug}
        staffId={offboardingStaffId}
        isOpen={offboardingOpen}
        onClose={() => setOffboardingOpen(false)}
        onCompleted={(message) => {
          setRows((current) =>
            current.map((row) =>
              row.id === offboardingStaffId ? { ...row, status: "inactive" } : row,
            ),
          );
          setToast({ variant: "success", message });
          refresh();
        }}
      />

      {/* ── Add team member (all-in-one: provider + optional login) ───────────── */}
      <AddTeamMemberSheet
        slug={slug}
        currentUserRole={currentUserRole}
        isOpen={addSheetOpen}
        onClose={() => setAddSheetOpen(false)}
        onToast={(message, kind) => setToast({ variant: kind, message })}
      />
    </div>
  );
}
