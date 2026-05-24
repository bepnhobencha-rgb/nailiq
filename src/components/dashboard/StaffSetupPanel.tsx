"use client";

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SaveButton, type SaveButtonStatus } from "@/components/ui/SaveButton";
import { SetupToast, type SetupToastPayload } from "@/components/ui/Toast";
import { SetupDeleteConfirm } from "@/components/dashboard/SetupDeleteConfirm";
import { cn } from "@/shared/lib/cn";
import {
  addStaff,
  deleteStaff,
  updateStaff,
  type StaffJobRole,
  type StaffStatus,
} from "@/shared/dashboard/setupActions";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

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

/** P1.8 — role labels are now localized via `setupStaff.roleOptions`.
 * Only the enum order is fixed here; labels resolve at render time so
 * VI sees "Chủ tiệm / Thợ chính / Thợ phụ" while EN keeps the English
 * names. */
const ROLE_VALUES: readonly StaffJobRole[] = [
  "owner",
  "senior",
  "nail_tech",
] as const;

const STATUS_VALUES: readonly StaffStatus[] = [
  "active",
  "pending",
  "inactive",
] as const;

const TOAST_ERR = "✗ Could not save. Check your connection.";

export function StaffSetupPanel({
  slug,
  initialRows,
  services,
  initialServiceIdsByStaff,
  salonHasCapabilityRows,
  maxStaff,
}: {
  slug: string;
  initialRows: SetupStaffRow[];
  services: SetupStaffServiceOption[];
  /** staffId → service IDs already attached. */
  initialServiceIdsByStaff: Record<string, string[]>;
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
  // P0.1 — shared setup-page labels.
  const tLabels = messages.setupLabels;
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [draftName, setDraftName] = useState("");
  const [draftRole, setDraftRole] = useState<StaffJobRole>("nail_tech");
  const [addSaveStatus, setAddSaveStatus] = useState<SaveButtonStatus>("idle");
  const [addError, setAddError] = useState<string | null>(null);
  const [toast, setToast] = useState<SetupToastPayload | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const addStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAddStatusTimer = useCallback(() => {
    if (addStatusTimerRef.current !== null) {
      clearTimeout(addStatusTimerRef.current);
      addStatusTimerRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      clearAddStatusTimer();
    },
    [clearAddStatusTimer],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- server list after refresh
    setRows(initialRows);
  }, [initialRows]);

  const refresh = useCallback(() => router.refresh(), [router]);

  // Row-level saving (pendingId) blocks the row's own Save/Remove buttons,
  // but must NOT block the Add form — that form has independent state and
  // its own addSaveStatus guard below.
  const isMutating = pendingId !== null || addSaveStatus === "saving";
  const atStaffLimit =
    Number.isFinite(maxStaff) && rows.length >= maxStaff;

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

  const handleDelete = useCallback(
    async (staffId: string) => {
      setFormError(null);
      setConfirmDeleteId(null);
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
        setFormError("Could not remove. Try again.");
        setToast({ variant: "error", message: TOAST_ERR });
        return;
      }
      setPendingId(null);
      if (!res.ok) {
        setFormError(mapDeleteStaffError(res.error, setupErrors));
        setToast({ variant: "error", message: TOAST_ERR });
        return;
      }
      setRows((prev) => prev.filter((r) => r.id !== staffId));
      setToast({ variant: "success", message: tLabels.staffRemoved });
      refresh();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tLabels.staffRemoved is a message string that doesn't change within a session
    [refresh, setupErrors, slug],
  );

  const onAdd = useCallback(async () => {
    setAddError(null);
    if (!draftName.trim()) {
      setAddError("Enter a name.");
      return;
    }
    clearAddStatusTimer();
    setAddSaveStatus("saving");
    let res: Awaited<ReturnType<typeof addStaff>>;
    try {
      // No serviceIds — server handles mode-aware auto-seed so we never
      // accidentally break the all-capable fallback for existing staff.
      res = await addStaff(slug, {
        name: draftName.trim(),
        role: draftRole,
      });
    } catch (err) {
      Sentry.captureMessage("[StaffSetupPanel] addStaff threw", {
        level: "error",
        tags: { "salon.action": "add_staff", "salon.slug": slug },
        extra: { name: draftName.trim(), error: String(err) },
      });
      setAddSaveStatus("error");
      setToast({ variant: "error", message: TOAST_ERR });
      addStatusTimerRef.current = setTimeout(() => setAddSaveStatus("idle"), 3000);
      return;
    }
    if (!res.ok) {
      setAddSaveStatus("error");
      // plan_limit_reached gets a localized inline message + Upgrade
      // link (rendered below); other errors fall back to the generic
      // toast so existing flows are unchanged.
      if (res.error === "plan_limit_reached") {
        setAddError(setupErrors.staffLimitReached);
      } else {
        setToast({ variant: "error", message: TOAST_ERR });
      }
      addStatusTimerRef.current = setTimeout(() => setAddSaveStatus("idle"), 3000);
      return;
    }
    setAddSaveStatus("saved");
    setToast({ variant: "success", message: tLabels.staffSaved });
    addStatusTimerRef.current = setTimeout(() => setAddSaveStatus("idle"), 2000);
    setDraftName("");
    setDraftRole("nail_tech");
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setupErrors.staffLimitReached and tLabels.staffSaved are message strings that don't change within a session
  }, [
    clearAddStatusTimer,
    draftName,
    draftRole,
    refresh,
    slug,
  ]);

  return (
    <div className="flex flex-col gap-4">
      <SetupToast toast={toast} onDismiss={() => setToast(null)} />

      {formError ? (
        <p className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error">
          {formError}
        </p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li
            key={row.id}
            className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-4"
          >
            <StaffRowFields
              row={row}
              services={services}
              /* Fallback rule: if no row in the salon has any services yet,
                 every staff is capable of every service. The form mirrors
                 that by pre-checking everything until the owner saves. */
              initialServiceIds={
                salonHasCapabilityRows
                  ? (initialServiceIdsByStaff[row.id] ?? [])
                  : services.map((s) => s.id)
              }
              capabilityLabel={setupStaffCopy.servicesCapableLabel}
              capabilityHint={setupStaffCopy.servicesCapableHint}
              capabilityEmpty={setupStaffCopy.noServicesAvailable}
              disabled={pendingId === row.id}
              confirmingDelete={confirmDeleteId === row.id}
              onBeginDelete={() => {
                setConfirmDeleteId(row.id);
              }}
              onCancelDelete={() => {
                setConfirmDeleteId(null);
              }}
              onConfirmDelete={() => {
                void handleDelete(row.id);
              }}
              onRowSave={(partial) => {
                void handleUpdate(row.id, partial);
              }}
              canDelete={rows.length > 1}
              saveButtonLabel={messages.serviceForm.saveButton}
            />
          </li>
        ))}
      </ul>

      <section
        aria-label={tLabels.addStaff}
        className="rounded-2xl border border-nq-primary/35 bg-nq-bg/85 p-4"
      >
        <h2 className="text-base font-semibold text-nq-foreground">{tLabels.addStaff}</h2>
        {atStaffLimit ? (
          <p
            className="mt-2 rounded-xl border border-nq-primary/30 bg-nq-primary/10 px-3 py-2 text-sm text-nq-foreground"
            role="status"
            data-testid="staff-at-limit-banner"
          >
            {setupErrors.staffLimitReached}{" "}
            <Link
              href={`/dashboard/${encodeURIComponent(slug)}/settings`}
              className="font-semibold text-nq-primary hover:text-nq-primary/85 underline-offset-2 hover:underline"
              data-testid="staff-at-limit-upgrade-link"
            >
              {setupErrors.upgradeCta}
            </Link>
          </p>
        ) : null}
        {addError ? (
          <p
            className="mt-2 text-sm text-nq-error"
            role="alert"
            data-testid="staff-add-error"
          >
            {addError}
            {addError === setupErrors.staffLimitReached ? (
              <>
                {" "}
                <Link
                  href={`/dashboard/${encodeURIComponent(slug)}/settings`}
                  className="font-semibold text-nq-primary hover:text-nq-primary/85 underline-offset-2 hover:underline"
                  data-testid="staff-add-upgrade-link"
                >
                  {setupErrors.upgradeCta}
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
        <div className="mt-3 flex flex-col gap-3">
          <label className="block text-sm font-medium text-nq-muted">
            {tLabels.name}
            <input
              className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus"
              value={draftName}
              disabled={addSaveStatus === "saving"}
              onChange={(e) => {
                setDraftName(e.target.value);
              }}
            />
          </label>
          <label className="block text-sm font-medium text-nq-muted">
            {setupStaffCopy.roleLabel}
            <select
              className="mt-1.5 flex min-h-[44px] w-full appearance-none rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus"
              value={draftRole}
              disabled={addSaveStatus === "saving"}
              onChange={(e) => {
                setDraftRole(e.target.value as StaffJobRole);
              }}
            >
              {ROLE_VALUES.map((v) => (
                <option key={v} value={v}>
                  {setupStaffCopy.roleOptions[v]}
                </option>
              ))}
            </select>
          </label>
          <SaveButton
            status={addSaveStatus}
            onSave={() => {
              void onAdd();
            }}
            idleLabel={tLabels.addStaff}
            savedLabel="✓ Saved"
            disabled={addSaveStatus === "saving" || !draftName.trim()}
            className="min-h-11 w-full"
          />
        </div>
      </section>
    </div>
  );
}

function mapDeleteStaffError(
  code: string,
  setupErrors: { staffHasBookings: string },
): string {
  if (code === "minimum_staff") {
    return "You need more than one staff member before you can remove someone.";
  }
  if (
    code === "staff_has_bookings" ||
    code === "in_use"
  ) {
    return setupErrors.staffHasBookings;
  }
  return "Could not remove. Try again.";
}

function StaffRowFields({
  row,
  services,
  initialServiceIds,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for future capability label display; kept in props for API compatibility
  capabilityLabel: _capabilityLabel,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for future capability hint display; kept in props for API compatibility
  capabilityHint: _capabilityHint,
  capabilityEmpty,
  disabled,
  confirmingDelete,
  onBeginDelete,
  onCancelDelete,
  onConfirmDelete,
  onRowSave,
  canDelete,
  saveButtonLabel,
}: {
  row: SetupStaffRow;
  services: SetupStaffServiceOption[];
  initialServiceIds: string[];
  capabilityLabel: string;
  capabilityHint: string;
  capabilityEmpty: string;
  disabled: boolean;
  confirmingDelete: boolean;
  onBeginDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  /** P1.1 — explicit Save commits all dirty fields at once. */
  onRowSave: (
    patch: Partial<Pick<SetupStaffRow, "name" | "job_role" | "status">> & {
      serviceIds?: string[];
    },
  ) => void;
  canDelete: boolean;
  saveButtonLabel: string;
}) {
  const { language } = useUserLanguage();
  const setupStaffCopy = getUserMessages(language).setupStaff;
  // P0.1 — pull shared labels for the row's Name + Remove buttons.
  const tLabels = getUserMessages(language).setupLabels;
  const [name, setName] = useState(row.name);
  const [role, setRole] = useState<StaffJobRole>(row.job_role);
  const [status, setStatus] = useState<StaffStatus>(row.status);
  const [serviceIds, setServiceIds] = useState<string[]>(initialServiceIds);
  const [capabilityOpen, setCapabilityOpen] = useState(false);

  // P1.1 — sort + join is a stable canonical form for the capability
  // set; lets us detect dirty without spreading the array. Empty
  // string is treated as the row's "actually empty" state.
  const initialServicesKey = [...initialServiceIds].sort().join("|");
  const currentServicesKey = [...serviceIds].sort().join("|");
  const trimmedName = name.trim();
  const patch: Partial<Pick<SetupStaffRow, "name" | "job_role" | "status">> & {
    serviceIds?: string[];
  } = {};
  if (trimmedName && trimmedName !== row.name) patch.name = trimmedName;
  if (role !== row.job_role) patch.job_role = role;
  if (status !== row.status) patch.status = status;
  if (currentServicesKey !== initialServicesKey) patch.serviceIds = serviceIds;
  const isDirty = Object.keys(patch).length > 0;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- row props after save / refresh
    setName(row.name);
    setRole(row.job_role);
    setStatus(row.status);
    setServiceIds(initialServiceIds);
    /* `initialServiceIds` is computed from a fresh prop on every server
       refresh; identity changes are intentional. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row, initialServiceIds.join("|")]);

  const statusLabelFor = (s: StaffStatus): string =>
    s === "active"
      ? setupStaffCopy.statusActive
      : s === "pending"
        ? setupStaffCopy.statusPending
        : setupStaffCopy.statusInactive;

  if (confirmingDelete) {
    return (
      <SetupDeleteConfirm
        title={`Delete ${row.name}?`}
        onCancel={onCancelDelete}
        onConfirm={onConfirmDelete}
        busy={disabled}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {status !== "active" ? (
        <span
          className={cn(
            "inline-flex w-fit items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em]",
            status === "pending"
              ? "border border-nq-warning/45 bg-nq-warning/12 text-nq-warning"
              : "border border-nq-muted/40 bg-nq-muted/10 text-nq-muted",
          )}
          aria-label={
            status === "pending"
              ? setupStaffCopy.pendingBadge
              : setupStaffCopy.inactiveBadge
          }
          data-testid={`staff-status-badge-${status}`}
        >
          {status === "pending"
            ? setupStaffCopy.pendingBadge
            : setupStaffCopy.inactiveBadge}
        </span>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-nq-muted">
          {tLabels.name}
          <input
            className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/85 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
            value={name}
            disabled={disabled}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block text-sm font-medium text-nq-muted">
          {setupStaffCopy.roleLabel}
          <select
            className="mt-1.5 flex min-h-[44px] w-full appearance-none rounded-xl border border-nq-border/50 bg-nq-bg/85 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
            value={role}
            disabled={disabled}
            onChange={(e) => setRole(e.target.value as StaffJobRole)}
          >
            {ROLE_VALUES.map((v) => (
              <option key={v} value={v}>
                {setupStaffCopy.roleOptions[v]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-sm font-medium text-nq-muted">
        {setupStaffCopy.statusLabel}
        <select
          data-testid={`staff-status-select-${row.id}`}
          className="mt-1.5 flex min-h-[44px] w-full appearance-none rounded-xl border border-nq-border/50 bg-nq-bg/85 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60 sm:max-w-[16rem]"
          value={status}
          disabled={disabled}
          onChange={(e) => setStatus(e.target.value as StaffStatus)}
        >
          {STATUS_VALUES.map((v) => (
            <option key={v} value={v}>
              {statusLabelFor(v)}
            </option>
          ))}
        </select>
        <span className="mt-1.5 block text-xs text-nq-muted/85">
          {setupStaffCopy.statusHint}
        </span>
      </label>
      {services.length === 0 ? (
        <p className="text-sm text-nq-muted" role="note">{capabilityEmpty}</p>
      ) : capabilityOpen ? (
        <div className="flex flex-col gap-2">
          <ServicesCheckboxList
            services={services}
            selectedIds={serviceIds}
            disabled={disabled}
            label=""
            hint=""
            emptyLabel={capabilityEmpty}
            onChange={setServiceIds}
          />
          <button
            type="button"
            className="self-start text-xs text-nq-muted underline-offset-2 hover:text-nq-foreground hover:underline"
            onClick={() => setCapabilityOpen(false)}
          >
            Thu gọn
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-nq-muted">
            {serviceIds.length === services.length
              ? "Tất cả dịch vụ"
              : `${serviceIds.length}/${services.length} dịch vụ được phép`}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => setCapabilityOpen(true)}
          >
            Giới hạn dịch vụ →
          </Button>
        </div>
      )}
      {/* P1.1 — explicit Save button; commits all dirty fields
          (name/role/status/serviceIds) in one server call. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
        <Button
          type="button"
          variant="secondary"
          className="min-h-11 touch-manipulation sm:w-auto"
          disabled={disabled || !canDelete}
          onClick={onBeginDelete}
        >
          {tLabels.removeStaff}
        </Button>
        <Button
          type="button"
          variant="primary"
          data-testid={`staff-row-save-${row.id}`}
          className="min-h-11 touch-manipulation sm:w-auto"
          disabled={disabled || !isDirty}
          loading={disabled}
          onClick={() => onRowSave(patch)}
        >
          {saveButtonLabel}
        </Button>
      </div>
    </div>
  );
}

function ServicesCheckboxList({
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
