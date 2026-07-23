"use client";

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { SaveButton, type SaveButtonStatus } from "@/components/ui/SaveButton";
import { SetupToast, type SetupToastPayload } from "@/components/ui/Toast";
import { cn } from "@/shared/lib/cn";
import {
  addStaff,
  updateStaff,
  type StaffJobRole,
  type StaffStatus,
} from "@/shared/dashboard/setupActions";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import type { SetupStaffRow, SetupStaffServiceOption } from "./StaffSetupPanel";

// ── constants (mirrored from StaffSetupPanel) ─────────────────────────────────

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

// ── helpers ───────────────────────────────────────────────────────────────────

export function mapDeleteStaffError(
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

// ── ServicesCheckboxList (copied from StaffSetupPanel — not exported there) ───

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

// ── prop types ────────────────────────────────────────────────────────────────

export type StaffDrawerProps = {
  slug: string;
  /** null = add mode; non-null = edit mode */
  staff: SetupStaffRow | null;
  services: SetupStaffServiceOption[];
  /** Services currently assigned to this staff member */
  initialServiceIds: string[];
  /** When false, all-capable fallback: pre-check all services */
  salonHasCapabilityRows: boolean;
  isOpen: boolean;
  onClose: () => void;
  /** Called after a successful update with the updated row */
  onSaved: (updated: SetupStaffRow) => void;
  /** Called after a successful add — parent calls router.refresh() */
  onAdded: () => void;
  /** Delete button calls this then closes; parent handles undo-delete flow */
  onRequestDelete?: (staffId: string) => void;
  canDelete: boolean;
  atStaffLimit: boolean;
};

// ── main component ────────────────────────────────────────────────────────────

export function StaffDrawer({
  slug,
  staff,
  services,
  initialServiceIds,
  salonHasCapabilityRows,
  isOpen,
  onClose,
  onSaved,
  onAdded,
  onRequestDelete,
  canDelete,
  atStaffLimit,
}: StaffDrawerProps) {
  const { language } = useUserLanguage();
  const messages = getUserMessages(language);
  const setupStaffCopy = messages.setupStaff;
  const tLabels = messages.setupLabels;
  const setupErrors = messages.setupErrors;

  const isEditMode = staff !== null;

  // Effective initial service IDs: when no capability rows exist yet (all-capable
  // fallback), pre-check every service so the first save does not narrow capability.
  const effectiveInitialServiceIds = salonHasCapabilityRows
    ? initialServiceIds
    : services.map((s) => s.id);

  // ── form state ────────────────────────────────────────────────────────────

  const [name, setName] = useState(staff?.name ?? "");
  const [role, setRole] = useState<StaffJobRole>(staff?.job_role ?? "nail_tech");
  const [status, setStatus] = useState<StaffStatus>(staff?.status ?? "active");
  const [serviceIds, setServiceIds] = useState<string[]>(effectiveInitialServiceIds);
  const [capabilityOpen, setCapabilityOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveButtonStatus>("idle");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [toast, setToast] = useState<SetupToastPayload | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset all local state whenever the target staff changes (drawer opens for
  // a different member, or switches between add / edit mode).
  useEffect(() => {
    const nextServiceIds = salonHasCapabilityRows
      ? initialServiceIds
      : services.map((s) => s.id);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset when drawer target changes
    setName(staff?.name ?? "");
    setRole(staff?.job_role ?? "nail_tech");
    setStatus(staff?.status ?? "active");
    setServiceIds(nextServiceIds);
    setCapabilityOpen(false);
    setSaveStatus("idle");
    setFieldError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff, initialServiceIds.join("|"), salonHasCapabilityRows]);

  // ── dirty-patch (edit mode) ───────────────────────────────────────────────

  const initialServicesKey = [...effectiveInitialServiceIds].sort().join("|");
  const currentServicesKey = [...serviceIds].sort().join("|");
  const trimmedName = name.trim();

  const patch: Partial<Pick<SetupStaffRow, "name" | "job_role" | "status">> & {
    serviceIds?: string[];
  } = {};
  if (trimmedName && staff && trimmedName !== staff.name) patch.name = trimmedName;
  if (staff && role !== staff.job_role) patch.job_role = role;
  if (staff && status !== staff.status) patch.status = status;
  if (currentServicesKey !== initialServicesKey) patch.serviceIds = serviceIds;
  const isDirty = Object.keys(patch).length > 0;

  // ── save state ────────────────────────────────────────────────────────────

  const clearTimer = useCallback(() => {
    if (statusTimerRef.current !== null) {
      clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      clearTimer();
    },
    [clearTimer],
  );

  // ── handlers ─────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    setFieldError(null);

    if (!name.trim()) {
      setFieldError("Enter a name.");
      return;
    }

    clearTimer();
    setSaveStatus("saving");

    if (isEditMode && staff) {
      // Edit mode: update the existing staff member.
      let res: Awaited<ReturnType<typeof updateStaff>>;
      try {
        res = await updateStaff(slug, staff.id, {
          name: patch.name,
          role: patch.job_role,
          status: patch.status,
          serviceIds: patch.serviceIds,
        });
      } catch (err) {
        Sentry.captureMessage("[StaffDrawer] updateStaff threw", {
          level: "error",
          tags: { "salon.action": "update_staff", "salon.slug": slug },
          extra: { staffId: staff.id, patch, error: String(err) },
        });
        setSaveStatus("error");
        setToast({ variant: "error", message: TOAST_ERR });
        statusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 3000);
        return;
      }
      if (!res.ok) {
        setSaveStatus("error");
        setToast({ variant: "error", message: TOAST_ERR });
        statusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 3000);
        return;
      }
      setSaveStatus("saved");
      setToast({ variant: "success", message: tLabels.staffSaved });
      statusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
      onSaved({
        ...staff,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.job_role !== undefined ? { job_role: patch.job_role } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      });
    } else {
      // Add mode: create a new staff member.
      let res: Awaited<ReturnType<typeof addStaff>>;
      try {
        res = await addStaff(slug, {
          name: name.trim(),
          role,
        });
      } catch (err) {
        Sentry.captureMessage("[StaffDrawer] addStaff threw", {
          level: "error",
          tags: { "salon.action": "add_staff", "salon.slug": slug },
          extra: { name: name.trim(), error: String(err) },
        });
        setSaveStatus("error");
        setToast({ variant: "error", message: TOAST_ERR });
        statusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 3000);
        return;
      }
      if (!res.ok) {
        setSaveStatus("error");
        if (res.error === "plan_limit_reached") {
          setFieldError(setupErrors.staffLimitReached);
        } else {
          setToast({ variant: "error", message: TOAST_ERR });
        }
        statusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 3000);
        return;
      }
      setSaveStatus("saved");
      setToast({ variant: "success", message: tLabels.staffSaved });
      statusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
      onAdded();
    }
  }, [
    clearTimer,
    isEditMode,
    name,
    onAdded,
    onSaved,
    patch,
    role,
    setupErrors.staffLimitReached,
    slug,
    staff,
    tLabels.staffSaved,
  ]);

  const handleDeleteClick = useCallback(() => {
    if (staff && onRequestDelete) {
      onRequestDelete(staff.id);
      onClose();
    }
  }, [onClose, onRequestDelete, staff]);

  // ── derived save-button disabled state ───────────────────────────────────

  const isSaving = saveStatus === "saving";

  const saveDisabled = isEditMode
    ? isSaving || !isDirty
    : isSaving || atStaffLimit || !name.trim();

  // ── localized helpers ─────────────────────────────────────────────────────

  const drawerTitle = isEditMode
    ? language === "vi"
      ? "Chỉnh sửa nhân viên"
      : "Edit staff member"
    : language === "vi"
      ? "Thêm nhân viên"
      : "Add staff member";

  const drawerDescription = isEditMode && staff ? staff.name : undefined;

  // ── footer ────────────────────────────────────────────────────────────────

  const footer = (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      {isEditMode ? (
        <>
          <Button
            type="button"
            variant="secondary"
            size="md"
            className="min-h-11 touch-manipulation"
            disabled={isSaving || !canDelete}
            onClick={handleDeleteClick}
          >
            {tLabels.removeStaff}
          </Button>
          <SaveButton
            status={saveStatus}
            onSave={() => void handleSave()}
            idleLabel={messages.serviceForm.saveButton}
            savedLabel="✓ Saved"
            disabled={saveDisabled}
            className="min-h-11"
          />
        </>
      ) : (
        <>
          <Button
            type="button"
            variant="ghost"
            size="md"
            className="min-h-11 touch-manipulation"
            disabled={isSaving}
            onClick={onClose}
          >
            {language === "vi" ? "Hủy" : "Cancel"}
          </Button>
          {atStaffLimit ? (
            <p
              className="rounded-xl border border-nq-primary/30 bg-nq-primary/10 px-3 py-2 text-sm text-nq-foreground"
              role="status"
            >
              {setupErrors.staffLimitReached}{" "}
              <Link
                href={`/dashboard/${encodeURIComponent(slug)}/settings`}
                className="font-semibold text-nq-primary underline-offset-2 hover:text-nq-primary/85 hover:underline"
              >
                {setupErrors.upgradeCta}
              </Link>
            </p>
          ) : (
            <SaveButton
              status={saveStatus}
              onSave={() => void handleSave()}
              idleLabel={tLabels.addStaff}
              savedLabel="✓ Saved"
              disabled={saveDisabled}
              className="min-h-11"
            />
          )}
        </>
      )}
    </div>
  );

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Toast rendered outside the Drawer portal so it is always visible */}
      <SetupToast toast={toast} onDismiss={() => setToast(null)} />

      <Drawer
        isOpen={isOpen}
        onClose={onClose}
        variant="right"
        size="md"
        title={drawerTitle}
        description={drawerDescription}
        footer={footer}
        showCloseButton
      >
        {/* Validation / field error */}
        {fieldError ? (
          <p
            className="mb-3 rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error"
            role="alert"
            data-testid="staff-drawer-field-error"
          >
            {fieldError}
          </p>
        ) : null}

        {/* Add mode: upgrade banner above the form */}
        {!isEditMode && atStaffLimit ? (
          <div
            className="mb-3 rounded-xl border border-nq-primary/30 bg-nq-primary/10 px-3 py-2 text-sm text-nq-foreground"
            role="status"
            data-testid="staff-drawer-at-limit-banner"
          >
            {setupErrors.staffLimitReached}{" "}
            <Link
              href={`/dashboard/${encodeURIComponent(slug)}/settings`}
              className="font-semibold text-nq-primary underline-offset-2 hover:text-nq-primary/85 hover:underline"
            >
              {setupErrors.upgradeCta}
            </Link>
          </div>
        ) : null}

        <div className="flex flex-col gap-3">
          {/* Name */}
          <label className="block text-sm font-medium text-nq-muted">
            {tLabels.name}
            <input
              className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
              value={name}
              disabled={isSaving}
              placeholder={language === "vi" ? "Tên nhân viên" : "Staff name"}
              onChange={(e) => setName(e.target.value)}
              data-testid="staff-drawer-name"
            />
          </label>

          {/* Role */}
          <label className="block text-sm font-medium text-nq-muted">
            {setupStaffCopy.roleLabel}
            <select
              className="mt-1.5 flex min-h-[44px] w-full appearance-none rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
              value={role}
              disabled={isSaving}
              onChange={(e) => setRole(e.target.value as StaffJobRole)}
              data-testid="staff-drawer-role"
            >
              {ROLE_VALUES.map((v) => (
                <option key={v} value={v}>
                  {setupStaffCopy.roleOptions[v]}
                </option>
              ))}
            </select>
          </label>

          {/* Status — only in edit mode; new staff always start as active */}
          {isEditMode ? (
            <label className="block text-sm font-medium text-nq-muted">
              {setupStaffCopy.statusLabel}
              <select
                className="mt-1.5 flex min-h-[44px] w-full appearance-none rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
                value={status}
                disabled={isSaving}
                onChange={(e) => setStatus(e.target.value as StaffStatus)}
                data-testid="staff-drawer-status"
              >
                {STATUS_VALUES.map((v) => (
                  <option key={v} value={v}>
                    {v === "active"
                      ? setupStaffCopy.statusActive
                      : v === "pending"
                        ? setupStaffCopy.statusPending
                        : setupStaffCopy.statusInactive}
                  </option>
                ))}
              </select>
              <span className="mt-1.5 block text-xs text-nq-muted/85">
                {setupStaffCopy.statusHint}
              </span>
            </label>
          ) : null}

          {/* Services capability */}
          {services.length === 0 ? (
            <p className="text-sm text-nq-muted" role="note">
              {setupStaffCopy.noServicesAvailable}
            </p>
          ) : capabilityOpen ? (
            <div className="flex flex-col gap-2">
              <ServicesCheckboxList
                services={services}
                selectedIds={serviceIds}
                disabled={isSaving}
                label={setupStaffCopy.servicesCapableLabel}
                hint={setupStaffCopy.servicesCapableHint}
                emptyLabel={setupStaffCopy.noServicesAvailable}
                onChange={setServiceIds}
              />
              <button
                type="button"
                className={cn(
                  "self-start text-xs text-nq-muted underline-offset-2",
                  "hover:text-nq-foreground hover:underline",
                )}
                onClick={() => setCapabilityOpen(false)}
              >
                {language === "vi" ? "Thu gọn" : "Collapse"}
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-nq-muted">
                {serviceIds.length === services.length
                  ? language === "vi"
                    ? "Tất cả dịch vụ"
                    : "All services"
                  : language === "vi"
                    ? `${serviceIds.length}/${services.length} dịch vụ được phép`
                    : `${serviceIds.length}/${services.length} services allowed`}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isSaving}
                onClick={() => setCapabilityOpen(true)}
              >
                {language === "vi" ? "Giới hạn dịch vụ →" : "Limit services →"}
              </Button>
            </div>
          )}
        </div>
      </Drawer>
    </>
  );
}

export default StaffDrawer;
