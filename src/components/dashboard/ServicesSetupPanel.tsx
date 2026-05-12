"use client";

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SaveButton, type SaveButtonStatus } from "@/components/ui/SaveButton";
import { SetupToast, type SetupToastPayload } from "@/components/ui/Toast";
import { SetupDeleteConfirm } from "@/components/dashboard/SetupDeleteConfirm";
import {
  addService,
  deleteService,
  updateService,
} from "@/shared/dashboard/setupActions";
import type { ServiceCategorySummary } from "@/shared/booking/loadServiceCategories";
import {
  DEFAULT_SERVICE_CATEGORY,
  type ServiceCategory,
} from "@/shared/booking/serviceCategory";
import { SERVICE_DESCRIPTION_MAX_LEN } from "@/shared/dashboard/serviceConstraints";
import { getUserMessages, type UserMessages } from "@/shared/i18n/user";
import type { Currency } from "@/shared/lib/currencyFormat";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

export type SetupServiceRow = {
  id: string;
  name: string;
  price_cents: number;
  duration_minutes: number;
  buffer_minutes: number;
  category: ServiceCategory;
  description: string | null;
  is_popular: boolean;
  is_featured: boolean;
};

type ServiceFormLabels = UserMessages["serviceForm"];
type CategoryPickerLabels = Pick<
  UserMessages["serviceCategory"],
  "pickerLabel"
>;

function centsFromDollarsString(raw: string): number | null {
  const normalized = raw.replace(/[^0-9.]/g, "");
  const n = Number.parseFloat(normalized);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function dollarsFromCents(cents: number): string {
  return (Math.round(cents) / 100).toFixed(2);
}

const TOAST_ERR = "✗ Could not save. Check your connection.";

export function ServicesSetupPanel({
  slug,
  initialRows,
  maxServices,
  currency,
  categories,
}: {
  slug: string;
  initialRows: SetupServiceRow[];
  /** Server-resolved cap (from `getEffectivePlanLimits`). `Infinity`
   *  for unlimited plans / feature-flag overrides. Server still
   *  re-validates on every `addService` call. */
  maxServices: number;
  /** Salon's display currency. Drives the "Price ({sym})" labels in
   *  the add form and per-row editor. Stored cents are interpreted in
   *  this currency by every formatter. */
  currency: Currency;
  /** Live category list from `loadServiceCategories`. Populates the
   *  add-form dropdown and each row's category select. */
  categories: readonly ServiceCategorySummary[];
}) {
  const { language } = useUserLanguage();
  const messages = getUserMessages(language);
  const setupErrors = messages.setupErrors;
  const categoryPickerLabel = messages.serviceCategory.pickerLabel;
  const formLabels = messages.serviceForm;
  // Localized + memo-friendly option list. Computed once per render
  // and passed down so per-row dropdowns don't each re-localize.
  const categoryOptions = categories.map((c) => ({
    value: c.slug,
    label: language === "vi" ? c.nameVi : c.nameEn,
  }));
  const router = useRouter();
  const [rows, setRows] = useState<SetupServiceRow[]>(initialRows);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSaveStatus, setAddSaveStatus] = useState<SaveButtonStatus>("idle");
  const [toast, setToast] = useState<SetupToastPayload | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const addStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [draftName, setDraftName] = useState("");
  const [draftPrice, setDraftPrice] = useState("");
  const [draftDur, setDraftDur] = useState("45");
  const [draftBuf, setDraftBuf] = useState("10");
  const [draftCategory, setDraftCategory] = useState<ServiceCategory>(
    DEFAULT_SERVICE_CATEGORY,
  );
  const [draftDescription, setDraftDescription] = useState("");
  const [draftIsPopular, setDraftIsPopular] = useState(false);

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

  // "Any mutation in flight" — disables the Add button and the
  // per-row blur-saves while another save is round-tripping. Prevents
  // a rapid-tap from queueing two creates / two updates from the same
  // form and getting an inconsistent UI.
  const isMutating = pendingId !== null || addSaveStatus === "saving";

  // Plan-cap UX gate. `rows` reflects the optimistic-after-confirm
  // state, so this stays accurate as the owner adds/removes services
  // without a refetch. Server-side validator still re-checks every
  // request, so this is a UX nudge, not a security boundary.
  const atServiceLimit =
    Number.isFinite(maxServices) && rows.length >= maxServices;

  const handleUpdate = useCallback(
    async (
      serviceId: string,
      patch: Partial<
        Pick<
          SetupServiceRow,
          | "name"
          | "price_cents"
          | "duration_minutes"
          | "buffer_minutes"
          | "category"
          | "description"
          | "is_popular"
          | "is_featured"
        >
      >,
    ) => {
      setFormError(null);
      setPendingId(serviceId);
      let res: Awaited<ReturnType<typeof updateService>>;
      try {
        res = await updateService(slug, serviceId, patch);
      } catch (err) {
        // Unexpected throw (network blip, server-action crash). Surface
        // a red toast and log to Sentry — without this branch the
        // pending state would stick and the owner would see no signal.
        Sentry.captureMessage(
          "[ServicesSetupPanel] updateService threw",
          {
            level: "error",
            tags: { "salon.action": "update_service", "salon.slug": slug },
            extra: { serviceId, patch, error: String(err) },
          },
        );
        setPendingId(null);
        setFormError("Could not save. Try again.");
        setToast({ variant: "error", message: TOAST_ERR });
        return;
      }
      setPendingId(null);
      if (!res.ok) {
        setFormError(mapUpdateError(res.error, formLabels));
        setToast({ variant: "error", message: TOAST_ERR });
        return;
      }
      setRows((prev) =>
        prev.map((r) =>
          r.id === serviceId
            ? {
                ...r,
                ...(patch.name !== undefined ? { name: patch.name } : {}),
                ...(patch.price_cents !== undefined
                  ? { price_cents: patch.price_cents }
                  : {}),
                ...(patch.duration_minutes !== undefined
                  ? { duration_minutes: patch.duration_minutes }
                  : {}),
                ...(patch.buffer_minutes !== undefined
                  ? { buffer_minutes: patch.buffer_minutes }
                  : {}),
                ...(patch.category !== undefined
                  ? { category: patch.category }
                  : {}),
                ...(patch.description !== undefined
                  ? { description: patch.description }
                  : {}),
                ...(patch.is_popular !== undefined
                  ? { is_popular: patch.is_popular }
                  : {}),
                ...(patch.is_featured !== undefined
                  ? { is_featured: patch.is_featured }
                  : {}),
              }
            : r,
        ),
      );
      // Prefer the "description generated" toast when the server's
      // best-effort auto-gen kicked in — it's a more specific signal
      // than the generic save toast and replaces it for ~2s.
      setToast(
        res.descriptionGenerated
          ? {
              variant: "success",
              message: formLabels.descriptionGeneratedToast,
            }
          : { variant: "success", message: "✓ Service saved" },
      );
      refresh();
    },
    [formLabels.descriptionGeneratedToast, refresh, slug],
  );

  const handleDelete = useCallback(
    async (serviceId: string) => {
      setFormError(null);
      setConfirmDeleteId(null);
      setPendingId(serviceId);
      let res: Awaited<ReturnType<typeof deleteService>>;
      try {
        res = await deleteService(slug, serviceId);
      } catch (err) {
        Sentry.captureMessage(
          "[ServicesSetupPanel] deleteService threw",
          {
            level: "error",
            tags: { "salon.action": "delete_service", "salon.slug": slug },
            extra: { serviceId, error: String(err) },
          },
        );
        setPendingId(null);
        setFormError("Could not delete. Try again.");
        setToast({ variant: "error", message: TOAST_ERR });
        return;
      }
      setPendingId(null);
      if (!res.ok) {
        setFormError(mapDeleteError(res.error, setupErrors));
        setToast({ variant: "error", message: TOAST_ERR });
        return;
      }
      setRows((prev) => prev.filter((r) => r.id !== serviceId));
      setToast({ variant: "success", message: "✓ Service removed" });
      refresh();
    },
    [refresh, setupErrors, slug],
  );

  const onAdd = useCallback(async () => {
    setAddError(null);
    const cents = centsFromDollarsString(draftPrice);
    if (!draftName.trim()) {
      setAddError("Enter a service name.");
      return;
    }
    if (cents === null) {
      setAddError("Enter a valid price.");
      return;
    }
    const dm = Number.parseInt(draftDur, 10);
    const bm = Number.parseInt(draftBuf, 10);
    if (!Number.isFinite(dm) || dm < 1) {
      setAddError("Duration must be at least 1 minute.");
      return;
    }
    if (!Number.isFinite(bm) || bm < 0) {
      setAddError("Buffer must be 0 or more minutes.");
      return;
    }

    // Description length is also enforced server-side (SERVICE_DESCRIPTION_MAX_LEN);
    // catching it pre-flight gives the owner a localized error without a round-trip.
    const descTrimmed = draftDescription.trim();
    if (descTrimmed.length > SERVICE_DESCRIPTION_MAX_LEN) {
      setAddError(formLabels.descriptionTooLong);
      return;
    }

    clearAddStatusTimer();
    setAddSaveStatus("saving");
    let res: Awaited<ReturnType<typeof addService>>;
    try {
      res = await addService(slug, {
        name: draftName.trim(),
        price_cents: cents,
        duration_minutes: dm,
        buffer_minutes: bm,
        category: draftCategory,
        description: descTrimmed.length > 0 ? descTrimmed : null,
        is_popular: draftIsPopular,
      });
    } catch (err) {
      Sentry.captureMessage("[ServicesSetupPanel] addService threw", {
        level: "error",
        tags: { "salon.action": "add_service", "salon.slug": slug },
        extra: { name: draftName.trim(), error: String(err) },
      });
      setAddSaveStatus("error");
      setToast({ variant: "error", message: TOAST_ERR });
      addStatusTimerRef.current = setTimeout(() => setAddSaveStatus("idle"), 3000);
      return;
    }
    if (!res.ok) {
      setAddSaveStatus("error");
      // plan_limit_reached → inline error + Upgrade link below;
      // invalid_description → localized hint; other errors fall back
      // to the generic toast.
      if (res.error === "plan_limit_reached") {
        setAddError(setupErrors.serviceLimitReached);
      } else if (res.error === "invalid_description") {
        setAddError(formLabels.descriptionTooLong);
      } else {
        setToast({ variant: "error", message: TOAST_ERR });
      }
      addStatusTimerRef.current = setTimeout(() => setAddSaveStatus("idle"), 3000);
      return;
    }
    setAddSaveStatus("saved");
    setToast(
      res.descriptionGenerated
        ? {
            variant: "success",
            message: formLabels.descriptionGeneratedToast,
          }
        : { variant: "success", message: "✓ Service saved" },
    );
    addStatusTimerRef.current = setTimeout(() => setAddSaveStatus("idle"), 2000);
    setDraftName("");
    setDraftPrice("");
    setDraftDur("45");
    setDraftBuf("10");
    setDraftCategory(DEFAULT_SERVICE_CATEGORY);
    setDraftDescription("");
    setDraftIsPopular(false);
    refresh();
  }, [
    clearAddStatusTimer,
    draftBuf,
    draftCategory,
    draftDescription,
    draftDur,
    draftIsPopular,
    draftName,
    draftPrice,
    formLabels.descriptionTooLong,
    refresh,
    setupErrors.serviceLimitReached,
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
            <ServiceRowFields
              row={row}
              disabled={pendingId === row.id}
              confirmingDelete={confirmDeleteId === row.id}
              categoryOptions={categoryOptions}
              categoryPickerLabel={categoryPickerLabel}
              formLabels={formLabels}
              currency={currency}
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
        aria-label="Add service"
        className="rounded-2xl border border-nq-primary/35 bg-nq-bg/85 p-4"
      >
        <h2 className="text-base font-semibold text-nq-foreground">
          Add service
        </h2>
        {atServiceLimit ? (
          <p
            className="mt-2 rounded-xl border border-nq-primary/30 bg-nq-primary/10 px-3 py-2 text-sm text-nq-foreground"
            role="status"
            data-testid="service-at-limit-banner"
          >
            {setupErrors.serviceLimitReached}{" "}
            <Link
              href={`/dashboard/${encodeURIComponent(slug)}/settings`}
              className="font-semibold text-nq-primary hover:text-nq-primary/85 underline-offset-2 hover:underline"
              data-testid="service-at-limit-upgrade-link"
            >
              {setupErrors.upgradeCta}
            </Link>
          </p>
        ) : null}
        {addError ? (
          <p
            className="mt-2 text-sm text-nq-error"
            role="alert"
            data-testid="service-add-error"
          >
            {addError}
            {addError === setupErrors.serviceLimitReached ? (
              <>
                {" "}
                <Link
                  href={`/dashboard/${encodeURIComponent(slug)}/settings`}
                  className="font-semibold text-nq-primary hover:text-nq-primary/85 underline-offset-2 hover:underline"
                  data-testid="service-add-upgrade-link"
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
              placeholder="e.g. Acrylic full set"
            />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block text-sm font-medium text-nq-muted">
              {`Price (${currency})`}
              <input
                inputMode="decimal"
                className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus"
                value={draftPrice}
                disabled={addSaveStatus === "saving"}
                onChange={(e) => {
                  setDraftPrice(e.target.value);
                }}
                placeholder="45.00"
              />
            </label>
            <label className="block text-sm font-medium text-nq-muted">
              Duration (min)
              <input
                inputMode="numeric"
                className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base tabular-nums text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus"
                value={draftDur}
                disabled={addSaveStatus === "saving"}
                onChange={(e) => {
                  setDraftDur(e.target.value);
                }}
              />
            </label>
            <label className="block text-sm font-medium text-nq-muted sm:col-span-2">
              Buffer (min)
              <input
                inputMode="numeric"
                className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base tabular-nums text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus"
                value={draftBuf}
                disabled={addSaveStatus === "saving"}
                onChange={(e) => {
                  setDraftBuf(e.target.value);
                }}
              />
            </label>
            <label className="block text-sm font-medium text-nq-muted sm:col-span-2">
              {categoryPickerLabel}
              <select
                className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus"
                value={draftCategory}
                disabled={addSaveStatus === "saving"}
                onChange={(e) => {
                  setDraftCategory(e.target.value as ServiceCategory);
                }}
                data-testid="service-category-add"
              >
                {categoryOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <DescriptionField
            value={draftDescription}
            disabled={addSaveStatus === "saving"}
            onChange={setDraftDescription}
            labels={formLabels}
            testId="service-description-add"
          />
          <PopularToggle
            checked={draftIsPopular}
            disabled={addSaveStatus === "saving"}
            onChange={setDraftIsPopular}
            labels={formLabels}
            testId="service-popular-add"
          />
          <SaveButton
            status={addSaveStatus}
            onSave={() => {
              void onAdd();
            }}
            idleLabel="Add service"
            savedLabel="✓ Saved"
            disabled={
              isMutating ||
              atServiceLimit ||
              !draftName.trim() ||
              centsFromDollarsString(draftPrice) === null ||
              draftDescription.trim().length > SERVICE_DESCRIPTION_MAX_LEN
            }
            className="min-h-11 w-full"
          />
        </div>
      </section>
    </div>
  );
}

function ServiceRowFields({
  row,
  disabled,
  confirmingDelete,
  categoryOptions,
  categoryPickerLabel,
  formLabels,
  currency: rowCurrency,
  onBeginDelete,
  onCancelDelete,
  onConfirmDelete,
  onBlurSave,
  canDelete,
}: {
  row: SetupServiceRow;
  disabled: boolean;
  confirmingDelete: boolean;
  categoryOptions: ReadonlyArray<{ value: string; label: string }>;
  categoryPickerLabel: CategoryPickerLabels["pickerLabel"];
  formLabels: ServiceFormLabels;
  currency: Currency;
  onBeginDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onBlurSave: (
    patch: Partial<
      Pick<
        SetupServiceRow,
        | "name"
        | "price_cents"
        | "duration_minutes"
        | "buffer_minutes"
        | "category"
        | "description"
        | "is_popular"
        | "is_featured"
      >
    >,
  ) => void;
  canDelete: boolean;
}) {
  const [name, setName] = useState(row.name);
  const [price, setPrice] = useState(dollarsFromCents(row.price_cents));
  const [dur, setDur] = useState(String(row.duration_minutes));
  const [buf, setBuf] = useState(String(row.buffer_minutes));
  const [description, setDescription] = useState(row.description ?? "");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- row props after save / refresh
    setName(row.name);
    setPrice(dollarsFromCents(row.price_cents));
    setDur(String(row.duration_minutes));
    setBuf(String(row.buffer_minutes));
    setDescription(row.description ?? "");
  }, [row]);

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
          {`Price (${rowCurrency})`}
          <input
            inputMode="decimal"
            className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/85 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
            value={price}
            disabled={disabled}
            onChange={(e) => {
              setPrice(e.target.value);
            }}
            onBlur={() => {
              const c = centsFromDollarsString(price);
              if (c !== null && c !== row.price_cents) onBlurSave({ price_cents: c });
            }}
          />
        </label>
        <label className="block text-sm font-medium text-nq-muted">
          Duration (min)
          <input
            inputMode="numeric"
            className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/85 px-3 py-2.5 text-base tabular-nums text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
            value={dur}
            disabled={disabled}
            onChange={(e) => {
              setDur(e.target.value);
            }}
            onBlur={() => {
              const n = Number.parseInt(dur, 10);
              if (
                Number.isFinite(n) &&
                n >= 1 &&
                n !== row.duration_minutes
              )
                onBlurSave({ duration_minutes: n });
            }}
          />
        </label>
        <label className="block text-sm font-medium text-nq-muted">
          Buffer (min)
          <input
            inputMode="numeric"
            className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/85 px-3 py-2.5 text-base tabular-nums text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
            value={buf}
            disabled={disabled}
            onChange={(e) => {
              setBuf(e.target.value);
            }}
            onBlur={() => {
              const n = Number.parseInt(buf, 10);
              if (Number.isFinite(n) && n >= 0 && n !== row.buffer_minutes)
                onBlurSave({ buffer_minutes: n });
            }}
          />
        </label>
        <label className="block text-sm font-medium text-nq-muted sm:col-span-2">
          {categoryPickerLabel}
          <select
            className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/85 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
            value={row.category}
            disabled={disabled}
            data-testid={`service-category-row-${row.id}`}
            onChange={(e) => {
              const next = e.target.value as ServiceCategory;
              if (next !== row.category) onBlurSave({ category: next });
            }}
          >
            {categoryOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <DescriptionField
        value={description}
        disabled={disabled}
        onChange={setDescription}
        labels={formLabels}
        testId={`service-description-row-${row.id}`}
        onBlurCommit={() => {
          const trimmed = description.trim();
          const next = trimmed.length === 0 ? null : trimmed;
          if (next !== (row.description ?? null)) {
            // Server-side validator will also reject oversized strings; the
            // input maxLength keeps the field short in normal use.
            if (next === null || next.length <= SERVICE_DESCRIPTION_MAX_LEN) {
              onBlurSave({ description: next });
            }
          }
        }}
      />
      <PopularToggle
        checked={row.is_popular}
        disabled={disabled}
        onChange={(next) => {
          if (next !== row.is_popular) {
            onBlurSave({ is_popular: next });
          }
        }}
        labels={formLabels}
        testId={`service-popular-row-${row.id}`}
      />
      <Button
        type="button"
        variant="secondary"
        className="min-h-11 w-full touch-manipulation sm:w-auto sm:self-start"
        disabled={disabled || !canDelete}
        onClick={onBeginDelete}
      >
        Delete service
      </Button>
    </div>
  );
}

function mapUpdateError(code: string, formLabels: ServiceFormLabels): string {
  if (code === "invalid_name") return "Fix the name and try again.";
  if (code === "invalid_description") return formLabels.descriptionTooLong;
  if (code === "not_found") return "Could not update that row.";
  return "Could not save. Try again.";
}

function mapDeleteError(
  code: string,
  setupErrors: { serviceInUse: string },
): string {
  if (code === "minimum_services")
    return "You need more than one service before you can delete.";
  if (code === "service_in_use" || code === "in_use")
    return setupErrors.serviceInUse;
  return "Could not delete. Try again.";
}

/** Description textarea with a live character counter. Shared by the
 *  add-form (commits on form submit) and each row (commits on blur). */
function DescriptionField({
  value,
  disabled,
  onChange,
  onBlurCommit,
  labels,
  testId,
}: {
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
  onBlurCommit?: () => void;
  labels: ServiceFormLabels;
  testId: string;
}) {
  const trimmed = value.trim();
  const used = trimmed.length;
  const over = used > SERVICE_DESCRIPTION_MAX_LEN;
  const counter = labels.characterCount
    .replace("{used}", String(used))
    .replace("{max}", String(SERVICE_DESCRIPTION_MAX_LEN));
  return (
    <label className="block text-sm font-medium text-nq-muted">
      <span className="flex items-baseline justify-between">
        <span>{labels.descriptionLabel}</span>
        <span
          className={
            over ? "text-xs text-nq-error" : "text-xs text-nq-muted/80"
          }
          aria-live="polite"
        >
          {counter}
        </span>
      </span>
      <textarea
        className="mt-1.5 flex min-h-[72px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
        rows={2}
        maxLength={SERVICE_DESCRIPTION_MAX_LEN}
        value={value}
        disabled={disabled}
        placeholder={labels.descriptionPlaceholder}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlurCommit}
      />
      <span className="mt-1 block text-xs text-nq-muted/80">
        {labels.descriptionHint}
      </span>
    </label>
  );
}

/** "Popular" checkbox toggle. Renders a small gold badge on the public
 *  booking page when checked (see BookingFlowServicePanel). */
function PopularToggle({
  checked,
  disabled,
  onChange,
  labels,
  testId,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  labels: ServiceFormLabels;
  testId: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-nq-border/40 bg-nq-bg/40 px-3 py-2.5 text-sm text-nq-foreground">
      <input
        type="checkbox"
        className="mt-0.5 h-5 w-5 cursor-pointer accent-nq-primary"
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="flex-1">
        <span className="block font-medium">{labels.popularLabel}</span>
        <span className="mt-0.5 block text-xs text-nq-muted">
          {labels.popularHint}
        </span>
      </span>
    </label>
  );
}
