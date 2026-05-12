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

const ROLE_OPTIONS: { value: StaffJobRole; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "senior", label: "Senior" },
  { value: "nail_tech", label: "Nail Tech" },
];

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
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [draftName, setDraftName] = useState("");
  const [draftRole, setDraftRole] = useState<StaffJobRole>("nail_tech");
  /** New-staff capability selection. Default: all checked, so an owner who
   *  doesn't think about it preserves the all-capable fallback for that staff. */
  const [draftServiceIds, setDraftServiceIds] = useState<string[]>(
    () => services.map((s) => s.id),
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-seed add-form draft when services list changes
    setDraftServiceIds(services.map((s) => s.id));
  }, [services]);
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

  // Mirrors ServicesSetupPanel — disables the Add button + lights up
  // the at-limit banner while any save is in flight.
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
      setToast({ variant: "success", message: "✓ Staff member saved" });
      refresh();
    },
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
      setToast({ variant: "success", message: "✓ Staff member removed" });
      refresh();
    },
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
      res = await addStaff(slug, {
        name: draftName.trim(),
        role: draftRole,
        serviceIds: draftServiceIds,
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
    setToast({ variant: "success", message: "✓ Staff member saved" });
    addStatusTimerRef.current = setTimeout(() => setAddSaveStatus("idle"), 2000);
    setDraftName("");
    setDraftRole("nail_tech");
    setDraftServiceIds(services.map((s) => s.id));
    refresh();
  }, [
    clearAddStatusTimer,
    draftName,
    draftRole,
    draftServiceIds,
    services,
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
              onBlurSave={(partial) => {
                void handleUpdate(row.id, partial);
              }}
              canDelete={rows.length > 1}
            />
          </li>
        ))}
      </ul>

      <section
        aria-label="Add staff"
        className="rounded-2xl border border-nq-primary/35 bg-nq-bg/85 p-4"
      >
        <h2 className="text-base font-semibold text-nq-foreground">Add staff</h2>
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
            Name
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
            Role
            <select
              className="mt-1.5 flex min-h-[44px] w-full appearance-none rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus"
              value={draftRole}
              disabled={addSaveStatus === "saving"}
              onChange={(e) => {
                setDraftRole(e.target.value as StaffJobRole);
              }}
            >
              {ROLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <ServicesCheckboxList
            services={services}
            selectedIds={draftServiceIds}
            disabled={addSaveStatus === "saving"}
            label={setupStaffCopy.servicesCapableLabel}
            hint={setupStaffCopy.servicesCapableHint}
            emptyLabel={setupStaffCopy.noServicesAvailable}
            onChange={setDraftServiceIds}
          />
          <SaveButton
            status={addSaveStatus}
            onSave={() => {
              void onAdd();
            }}
            idleLabel="Add staff"
            savedLabel="✓ Saved"
            disabled={isMutating || atStaffLimit || !draftName.trim()}
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
  capabilityLabel,
  capabilityHint,
  capabilityEmpty,
  disabled,
  confirmingDelete,
  onBeginDelete,
  onCancelDelete,
  onConfirmDelete,
  onBlurSave,
  canDelete,
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
  onBlurSave: (
    patch: Partial<Pick<SetupStaffRow, "name" | "job_role" | "status">> & {
      serviceIds?: string[];
    },
  ) => void;
  canDelete: boolean;
}) {
  const { language } = useUserLanguage();
  const setupStaffCopy = getUserMessages(language).setupStaff;
  const [name, setName] = useState(row.name);
  const [role, setRole] = useState<StaffJobRole>(row.job_role);
  const [status, setStatus] = useState<StaffStatus>(row.status);
  const [serviceIds, setServiceIds] = useState<string[]>(initialServiceIds);

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
          Name
          <input
            className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/85 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
            value={name}
            disabled={disabled}
            onChange={(e) => {
              setName(e.target.value);
            }}
            onBlur={() => {
              const t = name.trim();
              if (t && t !== row.name) onBlurSave({ name: t });
            }}
          />
        </label>
        <label className="block text-sm font-medium text-nq-muted">
          Role
          <select
            className="mt-1.5 flex min-h-[44px] w-full appearance-none rounded-xl border border-nq-border/50 bg-nq-bg/85 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
            value={role}
            disabled={disabled}
            onChange={(e) => {
              const v = e.target.value as StaffJobRole;
              setRole(v);
              if (v !== row.job_role) onBlurSave({ job_role: v });
            }}
          >
            {ROLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
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
          onChange={(e) => {
            const v = e.target.value as StaffStatus;
            setStatus(v);
            if (v !== row.status) onBlurSave({ status: v });
          }}
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
      <ServicesCheckboxList
        services={services}
        selectedIds={serviceIds}
        disabled={disabled}
        label={capabilityLabel}
        hint={capabilityHint}
        emptyLabel={capabilityEmpty}
        onChange={(next) => {
          setServiceIds(next);
          /* Save on every toggle. The row's name/role change paths debounce
             via blur; capability is a low-frequency, idempotent set so we
             don't bother batching. */
          onBlurSave({ serviceIds: next });
        }}
      />
      <Button
        type="button"
        variant="secondary"
        className="min-h-11 w-full touch-manipulation sm:w-auto sm:self-start"
        disabled={disabled || !canDelete}
        onClick={onBeginDelete}
      >
        Remove staff
      </Button>
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
