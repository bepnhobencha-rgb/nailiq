"use client";

import * as ErrorReporter from "@/shared/observability/errorReporter";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { SaveButton, type SaveButtonStatus } from "@/components/ui/SaveButton";
import { SetupToast, type SetupToastPayload } from "@/components/ui/Toast";
import {
  addService,
  updateService,
} from "@/shared/dashboard/setupActions";
import type { ServiceCategorySummary } from "@/shared/booking/loadServiceCategories";
import { parseServicePrepMinutes } from "@/shared/booking/bookingSequence";
import {
  ADD_FORM_DEFAULT_CATEGORY,
  type ServiceCategory,
} from "@/shared/booking/serviceCategory";
import { SERVICE_DESCRIPTION_MAX_LEN } from "@/shared/dashboard/serviceConstraints";
import { getUserMessages } from "@/shared/i18n/user";
import {
  type Currency,
  formatServicePrice,
  type ServicePriceType,
} from "@/shared/lib/currencyFormat";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import type { SetupServiceRow } from "./ServicesSetupPanel";

/**
 * The variable-pricing columns (`price_type` / `price_max_cents`) live on the
 * services row in the DB + database.types + the setup server actions. The
 * `SetupServiceRow` type (owned by ServicesSetupPanel) may not surface them
 * yet, so read them through this structural view to stay decoupled from that
 * file while remaining forward-compatible once the row type carries them.
 */
type ServicePricingFields = {
  price_type?: ServicePriceType | string | null;
  price_max_cents?: number | null;
};

function readPriceType(service: SetupServiceRow | null): ServicePriceType {
  const raw = (service as (SetupServiceRow & ServicePricingFields) | null)
    ?.price_type;
  return raw === "from" || raw === "range" ? raw : "fixed";
}

function readPriceMaxCents(service: SetupServiceRow | null): number | null {
  const raw = (service as (SetupServiceRow & ServicePricingFields) | null)
    ?.price_max_cents;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

// ── helpers (copied from ServicesSetupPanel so this module is self-contained) ──

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

// ── prop types ────────────────────────────────────────────────────────────────

export type ServiceDrawerProps = {
  slug: string;
  /** null = add mode; non-null = edit mode */
  service: SetupServiceRow | null;
  isOpen: boolean;
  onClose: () => void;
  /** Called after a successful update. Pass the updated SetupServiceRow back. */
  onSaved: (updated: SetupServiceRow) => void;
  /** Called after a successful add. */
  onAdded: () => void;
  currency: Currency;
  categories: readonly ServiceCategorySummary[];
  canDelete: boolean;
  /** When true, show "Service limit reached" instead of save button in add mode */
  atServiceLimit: boolean;
  /** Keeps prep editing absent for every flag-off salon. */
  multiServiceEditorEnabled: boolean;
  /** Delete button calls this with the service id then closes the drawer.
   *  Actual deletion + undo toast lives in the parent (ServicesSetupPanel). */
  onRequestDelete?: (id: string) => void;
};

// ── sub-components ────────────────────────────────────────────────────────────

/**
 * Textarea with a live character counter. Mirrors the DescriptionField in
 * ServicesSetupPanel — kept here so this module doesn't depend on unexported
 * internals.
 */
function DescriptionField({
  value,
  disabled,
  onChange,
  labels,
  testId,
}: {
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
  labels: ReturnType<typeof getUserMessages>["serviceForm"];
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
          className={over ? "text-xs text-nq-error" : "text-xs text-nq-muted/80"}
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
      />
      <span className="mt-1 block text-xs text-nq-muted/80">
        {labels.descriptionHint}
      </span>
    </label>
  );
}

/**
 * "Popular" checkbox toggle. Mirrors PopularToggle in ServicesSetupPanel.
 */
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
  labels: ReturnType<typeof getUserMessages>["serviceForm"];
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

// ── main component ────────────────────────────────────────────────────────────

export function ServiceDrawer({
  slug,
  service,
  isOpen,
  onClose,
  onSaved,
  onAdded,
  currency,
  categories,
  canDelete,
  atServiceLimit,
  multiServiceEditorEnabled,
  onRequestDelete,
}: ServiceDrawerProps) {
  const { language } = useUserLanguage();
  const messages = getUserMessages(language);
  const formLabels = messages.serviceForm;
  const tLabels = messages.setupLabels;
  const setupErrors = messages.setupErrors;
  const categoryPickerLabel = messages.serviceCategory.pickerLabel;

  const isEditMode = service !== null;

  // Localized category option list, same pattern as ServicesSetupPanel.
  const categoryOptions = categories.map((c) => ({
    value: c.slug,
    label: language === "vi" ? c.nameVi : c.nameEn,
  }));

  // ── form state ────────────────────────────────────────────────────────────

  const [name, setName] = useState(service?.name ?? "");
  const [price, setPrice] = useState(
    service ? dollarsFromCents(service.price_cents) : "",
  );
  // Variable pricing: 'fixed' | 'from' | 'range'. For 'range' the `price`
  // input above is the minimum/base and `priceMax` holds the upper bound.
  const [priceType, setPriceType] = useState<ServicePriceType>(
    readPriceType(service),
  );
  const [priceMax, setPriceMax] = useState(() => {
    const max = readPriceMaxCents(service);
    return max !== null ? dollarsFromCents(max) : "";
  });
  const [dur, setDur] = useState(
    service ? String(service.duration_minutes) : "45",
  );
  const [buf, setBuf] = useState(
    service ? String(service.buffer_minutes) : "10",
  );
  const [prep, setPrep] = useState(
    service ? String(service.prep_minutes) : "0",
  );
  const [category, setCategory] = useState<ServiceCategory>(
    service?.category ?? ADD_FORM_DEFAULT_CATEGORY,
  );
  const [description, setDescription] = useState(service?.description ?? "");
  const [isPopular, setIsPopular] = useState(service?.is_popular ?? false);
  const [isAddon, setIsAddon] = useState(service?.is_addon ?? false);
  const [addonTiming, setAddonTiming] = useState<"concurrent" | "sequential">(
    service?.addon_timing ?? "sequential",
  );
  // Declared before the reset effect below (which resets them) so they aren't
  // referenced before initialization.
  const [saveStatus, setSaveStatus] = useState<SaveButtonStatus>("idle");
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Reset all fields when the service prop changes (drawer opens for a
  // different service or switches between add/edit mode).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset when drawer target changes
    setName(service?.name ?? "");
    setPrice(service ? dollarsFromCents(service.price_cents) : "");
    setPriceType(readPriceType(service));
    const maxCents = readPriceMaxCents(service);
    setPriceMax(maxCents !== null ? dollarsFromCents(maxCents) : "");
    setDur(service ? String(service.duration_minutes) : "45");
    setBuf(service ? String(service.buffer_minutes) : "10");
    setPrep(service ? String(service.prep_minutes) : "0");
    setCategory(service?.category ?? ADD_FORM_DEFAULT_CATEGORY);
    setDescription(service?.description ?? "");
    setIsPopular(service?.is_popular ?? false);
    setIsAddon(service?.is_addon ?? false);
    setAddonTiming(service?.addon_timing ?? "sequential");
    setSaveStatus("idle");
    setFieldError(null);
  }, [service]);

  // ── save state ────────────────────────────────────────────────────────────

  const [toast, setToast] = useState<SetupToastPayload | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // ── dirty-patch (edit mode) ───────────────────────────────────────────────

  const buildDirtyPatch = useCallback(() => {
    if (!service) return {};
    const patch: Partial<
      Pick<
        SetupServiceRow,
        | "name"
        | "price_cents"
        | "duration_minutes"
        | "buffer_minutes"
        | "prep_minutes"
        | "category"
        | "description"
        | "is_popular"
        | "is_addon"
        | "addon_timing"
      >
    > & {
      price_type?: ServicePriceType;
      price_max_cents?: number | null;
    } = {};
    const nameTrim = name.trim();
    if (nameTrim && nameTrim !== service.name) patch.name = nameTrim;
    const cents = centsFromDollarsString(price);
    if (cents !== null && cents !== service.price_cents) patch.price_cents = cents;
    const durNum = Number.parseInt(dur, 10);
    if (Number.isFinite(durNum) && durNum >= 1 && durNum !== service.duration_minutes)
      patch.duration_minutes = durNum;
    const bufNum = Number.parseInt(buf, 10);
    if (Number.isFinite(bufNum) && bufNum >= 0 && bufNum !== service.buffer_minutes)
      patch.buffer_minutes = bufNum;
    const prepNum = parseServicePrepMinutes(prep);
    if (
      multiServiceEditorEnabled &&
      prepNum != null &&
      prepNum !== service.prep_minutes
    ) {
      patch.prep_minutes = prepNum;
    }
    if (category !== service.category) patch.category = category;
    const descTrim = description.trim();
    const descNext = descTrim.length === 0 ? null : descTrim;
    if (descNext !== (service.description ?? null)) patch.description = descNext;
    if (isPopular !== service.is_popular) patch.is_popular = isPopular;
    if (isAddon !== service.is_addon) patch.is_addon = isAddon;
    // Timing only matters for add-ons; persist when it changed.
    if (isAddon && addonTiming !== service.addon_timing)
      patch.addon_timing = addonTiming;
    // Pricing model: send price_type + price_max_cents together whenever the
    // model or the max changed. The server re-validates (clamps max > base,
    // downgrades range→from when max is missing/invalid).
    const nextMaxCents =
      priceType === "range" ? centsFromDollarsString(priceMax) : null;
    const prevType = readPriceType(service);
    const prevMaxCents = readPriceMaxCents(service);
    if (priceType !== prevType || nextMaxCents !== prevMaxCents) {
      patch.price_type = priceType;
      patch.price_max_cents = nextMaxCents;
    }
    return patch;
  }, [addonTiming, buf, category, description, dur, isAddon, isPopular, multiServiceEditorEnabled, name, prep, price, priceMax, priceType, service]);

  const patch = buildDirtyPatch();
  const isDirty = Object.keys(patch).length > 0;

  // ── validation helpers ────────────────────────────────────────────────────

  function validateFields(): string | null {
    if (!name.trim()) return "Enter a service name.";
    const baseCents = centsFromDollarsString(price);
    if (baseCents === null) return "Enter a valid price.";
    if (priceType === "range") {
      const maxCents = centsFromDollarsString(priceMax);
      if (maxCents === null)
        return language === "vi"
          ? "Nhập giá tối đa hợp lệ."
          : "Enter a valid maximum price.";
      if (maxCents <= baseCents) return formLabels.priceValidation;
    }
    const dm = Number.parseInt(dur, 10);
    if (!Number.isFinite(dm) || dm < 1) return "Duration must be at least 1 minute.";
    const bm = Number.parseInt(buf, 10);
    if (!Number.isFinite(bm) || bm < 0) return "Buffer must be 0 or more minutes.";
    if (multiServiceEditorEnabled) {
      const pm = parseServicePrepMinutes(prep);
      if (pm == null) {
        return language === "vi"
          ? "Thời gian chuẩn bị phải từ 0 đến 180 phút."
          : "Prep time must be between 0 and 180 minutes.";
      }
    }
    if (description.trim().length > SERVICE_DESCRIPTION_MAX_LEN)
      return formLabels.descriptionTooLong;
    return null;
  }

  // ── handlers ─────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    setFieldError(null);
    const validationErr = validateFields();
    if (validationErr) {
      setFieldError(validationErr);
      return;
    }

    clearTimer();
    setSaveStatus("saving");

    if (isEditMode && service) {
      // Edit mode: update the existing service.
      let res: Awaited<ReturnType<typeof updateService>>;
      try {
        res = await updateService(slug, service.id, patch);
      } catch (err) {
        ErrorReporter.captureMessage("[ServiceDrawer] updateService threw", {
          level: "error",
          tags: { "salon.action": "update_service", "salon.slug": slug },
          extra: { serviceId: service.id, patch, error: String(err) },
        });
        setSaveStatus("error");
        setToast({ variant: "error", message: TOAST_ERR });
        statusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 3000);
        return;
      }
      if (!res.ok) {
        const errMsg = mapUpdateError(res.error, formLabels);
        setSaveStatus("error");
        setFieldError(errMsg);
        setToast({ variant: "error", message: TOAST_ERR });
        statusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 3000);
        return;
      }
      setSaveStatus("saved");
      setToast(
        res.descriptionGenerated
          ? { variant: "success", message: formLabels.descriptionGeneratedToast }
          : { variant: "success", message: tLabels.serviceSaved },
      );
      statusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2000);

      // Build the updated row from the spread of original + patch.
      const updatedRow: SetupServiceRow = {
        ...service,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.price_cents !== undefined ? { price_cents: patch.price_cents } : {}),
        ...(patch.duration_minutes !== undefined ? { duration_minutes: patch.duration_minutes } : {}),
        ...(patch.buffer_minutes !== undefined ? { buffer_minutes: patch.buffer_minutes } : {}),
        ...(patch.prep_minutes !== undefined ? { prep_minutes: patch.prep_minutes } : {}),
        ...(patch.category !== undefined ? { category: patch.category } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.is_popular !== undefined ? { is_popular: patch.is_popular } : {}),
        ...(patch.is_addon !== undefined ? { is_addon: patch.is_addon } : {}),
        ...(patch.addon_timing !== undefined ? { addon_timing: patch.addon_timing } : {}),
        // Mirror the pricing model the server normalized to, so the parent's
        // in-memory row stays in sync. Spread as a structural view since
        // SetupServiceRow may not declare these columns yet.
        ...(patch.price_type !== undefined
          ? ({
              price_type: patch.price_type,
              price_max_cents: patch.price_max_cents ?? null,
            } satisfies ServicePricingFields)
          : {}),
      };
      onSaved(updatedRow);
    } else {
      // Add mode: create a new service.
      const cents = centsFromDollarsString(price)!;
      const dm = Number.parseInt(dur, 10);
      const bm = Number.parseInt(buf, 10);
      const pm = multiServiceEditorEnabled ? parseServicePrepMinutes(prep) : 0;
      const descTrimmed = description.trim();

      let res: Awaited<ReturnType<typeof addService>>;
      try {
        res = await addService(slug, {
          name: name.trim(),
          price_cents: cents,
          duration_minutes: dm,
          buffer_minutes: bm,
          ...(multiServiceEditorEnabled && pm != null ? { prep_minutes: pm } : {}),
          category,
          description: descTrimmed.length > 0 ? descTrimmed : null,
          is_popular: isPopular,
          is_addon: isAddon,
          addon_timing: isAddon ? addonTiming : "sequential",
          price_type: priceType,
          price_max_cents:
            priceType === "range" ? centsFromDollarsString(priceMax) : null,
        });
      } catch (err) {
        ErrorReporter.captureMessage("[ServiceDrawer] addService threw", {
          level: "error",
          tags: { "salon.action": "add_service", "salon.slug": slug },
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
          setFieldError(setupErrors.serviceLimitReached);
        } else if (res.error === "invalid_description") {
          setFieldError(formLabels.descriptionTooLong);
        } else {
          setToast({ variant: "error", message: TOAST_ERR });
        }
        statusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 3000);
        return;
      }
      setSaveStatus("saved");
      setToast(
        res.descriptionGenerated
          ? { variant: "success", message: formLabels.descriptionGeneratedToast }
          : { variant: "success", message: tLabels.serviceSaved },
      );
      statusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
      onAdded();
    }
  }, [
    buildDirtyPatch,
    buf,
    category,
    clearTimer,
    description,
    dur,
    formLabels,
    isAddon,
    addonTiming,
    isEditMode,
    isPopular,
    language,
    name,
    prep,
    onAdded,
    onSaved,
    patch,
    price,
    priceMax,
    priceType,
    multiServiceEditorEnabled,
    service,
    setupErrors.serviceLimitReached,
    slug,
    tLabels.serviceSaved,
  ]);

  const handleDeleteClick = useCallback(() => {
    if (service && onRequestDelete) {
      onRequestDelete(service.id);
      onClose();
    }
  }, [onClose, onRequestDelete, service]);

  // ── derived save-button disabled state ───────────────────────────────────

  const isSaving = saveStatus === "saving";
  const descTrimmedLen = description.trim().length;

  const saveDisabled = isEditMode
    ? isSaving || !isDirty || descTrimmedLen > SERVICE_DESCRIPTION_MAX_LEN
    : isSaving ||
      atServiceLimit ||
      !name.trim() ||
      centsFromDollarsString(price) === null ||
      descTrimmedLen > SERVICE_DESCRIPTION_MAX_LEN;

  // ── render ────────────────────────────────────────────────────────────────

  const drawerTitle = isEditMode ? formLabels.editTitle : formLabels.addTitle;

  const drawerDescription = isEditMode && service ? service.name : undefined;

  // ── pricing-model UI (fixed / from / range) ──────────────────────────────
  const fromLabel = formLabels.priceFromShort;
  const pricingModelLabel = formLabels.priceTypeLabel;
  const priceTypeOptions: { value: ServicePriceType; label: string }[] = [
    { value: "fixed", label: formLabels.priceTypeFixed },
    { value: "from", label: formLabels.priceTypeFrom },
    { value: "range", label: formLabels.priceTypeRange },
  ];
  // Base price input label adapts to the model: min for from/range, plain for fixed.
  const basePriceLabel =
    priceType === "fixed" ? tLabels.price : formLabels.priceMinLabel;
  const maxPriceLabel = formLabels.priceMaxLabel;

  // Live preview of how the price will render on public surfaces.
  const previewBaseCents = centsFromDollarsString(price);
  const previewMaxCents =
    priceType === "range" ? centsFromDollarsString(priceMax) : null;
  const pricePreview = formatServicePrice(previewBaseCents, currency, {
    priceType,
    priceMaxCents: previewMaxCents,
    fromLabel,
  });

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
            {tLabels.deleteService}
          </Button>
          <SaveButton
            status={saveStatus}
            onSave={() => void handleSave()}
            idleLabel={formLabels.saveButton}
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
            {formLabels.cancel}
          </Button>
          {atServiceLimit ? (
            <p className="rounded-xl border border-nq-primary/30 bg-nq-primary/10 px-3 py-2 text-sm text-nq-foreground">
              {setupErrors.serviceLimitReached}
            </p>
          ) : (
            <SaveButton
              status={saveStatus}
              onSave={() => void handleSave()}
              idleLabel={tLabels.addService}
              savedLabel="✓ Saved"
              disabled={saveDisabled}
              className="min-h-11"
            />
          )}
        </>
      )}
    </div>
  );

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
            data-testid="service-drawer-field-error"
          >
            {fieldError}
          </p>
        ) : null}

        <div className="flex flex-col gap-3">
          {/* Name */}
          <label className="block text-sm font-medium text-nq-muted">
            {tLabels.name}
            <input
              className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
              value={name}
              disabled={isSaving}
              placeholder="e.g. Acrylic full set"
              onChange={(e) => setName(e.target.value)}
              data-testid="service-drawer-name"
            />
          </label>

          {/* Pricing model: fixed / from / range */}
          <fieldset className="block text-sm font-medium text-nq-muted">
            <legend className="mb-1.5">{pricingModelLabel}</legend>
            <div
              className="grid grid-cols-3 gap-1 rounded-xl border border-nq-border/50 bg-nq-bg/40 p-1"
              role="radiogroup"
              aria-label={pricingModelLabel}
            >
              {priceTypeOptions.map((opt) => {
                const active = priceType === opt.value;
                return (
                  <label
                    key={opt.value}
                    className={`flex min-h-[40px] cursor-pointer items-center justify-center rounded-lg px-2 py-1.5 text-center text-sm font-medium transition-colors ${
                      active
                        ? "bg-nq-primary text-nq-bg shadow-nq-sm"
                        : "text-nq-muted hover:bg-nq-bg/80"
                    } ${isSaving ? "pointer-events-none opacity-60" : ""}`}
                  >
                    <input
                      type="radio"
                      name="service-price-type"
                      className="sr-only"
                      value={opt.value}
                      checked={active}
                      disabled={isSaving}
                      onChange={() => setPriceType(opt.value)}
                      data-testid={`service-drawer-price-type-${opt.value}`}
                    />
                    {opt.label}
                  </label>
                );
              })}
            </div>
            {/* Live preview of the rendered public price */}
            <span className="mt-1.5 block text-xs text-nq-muted/80">
              {language === "vi" ? "Hiển thị: " : "Shows as: "}
              <span
                className="font-medium tabular-nums text-nq-foreground"
                data-testid="service-drawer-price-preview"
              >
                {pricePreview ?? "—"}
              </span>
            </span>
          </fieldset>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/* Price (min/base) */}
            <label className="block text-sm font-medium text-nq-muted">
              {`${basePriceLabel} (${currency})`}
              <input
                inputMode="decimal"
                className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
                value={price}
                disabled={isSaving}
                placeholder="45.00"
                onChange={(e) => setPrice(e.target.value)}
                data-testid="service-drawer-price"
              />
            </label>

            {/* Max price — only for the 'range' model */}
            {priceType === "range" ? (
              <label className="block text-sm font-medium text-nq-muted">
                {`${maxPriceLabel} (${currency})`}
                <input
                  inputMode="decimal"
                  className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
                  value={priceMax}
                  disabled={isSaving}
                  placeholder="60.00"
                  onChange={(e) => setPriceMax(e.target.value)}
                  data-testid="service-drawer-price-max"
                />
              </label>
            ) : null}

            {/* Duration */}
            <label className="block text-sm font-medium text-nq-muted">
              {tLabels.durationMin}
              <input
                inputMode="numeric"
                className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base tabular-nums text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
                value={dur}
                disabled={isSaving}
                onChange={(e) => setDur(e.target.value)}
                data-testid="service-drawer-duration"
              />
            </label>

            {/* Buffer */}
            <label className="block text-sm font-medium text-nq-muted sm:col-span-2">
              {tLabels.bufferMin}
              <input
                inputMode="numeric"
                className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base tabular-nums text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
                value={buf}
                disabled={isSaving}
                onChange={(e) => setBuf(e.target.value)}
                data-testid="service-drawer-buffer"
              />
            </label>

            {multiServiceEditorEnabled ? (
              <label className="block text-sm font-medium text-nq-muted sm:col-span-2">
                {language === "vi" ? "Chuẩn bị trước dịch vụ (phút)" : "Prep before service (minutes)"}
                <input
                  inputMode="numeric"
                  min={0}
                  max={180}
                  className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base tabular-nums text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
                  value={prep}
                  disabled={isSaving}
                  onChange={(e) => setPrep(e.target.value)}
                  data-testid="service-drawer-prep"
                />
                <span className="mt-1 block text-xs text-nq-muted/80">
                  {language === "vi"
                    ? "Chiếm thời gian của thợ/tài nguyên trước khi bắt đầu phục vụ khách; khác với thời gian dọn sau dịch vụ."
                    : "Reserves staff/resource setup before customer work; separate from the cleanup buffer."}
                </span>
              </label>
            ) : null}

            {/* Category */}
            <label className="block text-sm font-medium text-nq-muted sm:col-span-2">
              {categoryPickerLabel}
              <select
                className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
                value={category}
                disabled={isSaving}
                onChange={(e) => setCategory(e.target.value as ServiceCategory)}
                data-testid="service-drawer-category"
              >
                {categoryOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* Description */}
          <DescriptionField
            value={description}
            disabled={isSaving}
            onChange={setDescription}
            labels={formLabels}
            testId="service-drawer-description"
          />

          {/* Popular toggle */}
          <PopularToggle
            checked={isPopular}
            disabled={isSaving}
            onChange={setIsPopular}
            labels={formLabels}
            testId="service-drawer-popular"
          />

          {/* Add-on toggle — hides this from the main picker; offered only as
              an upsell on the review step. */}
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-nq-border/40 bg-nq-bg/40 px-3 py-2.5 text-sm text-nq-foreground">
            <input
              type="checkbox"
              className="mt-0.5 h-5 w-5 cursor-pointer accent-nq-primary"
              checked={isAddon}
              disabled={isSaving}
              onChange={(e) => setIsAddon(e.target.checked)}
              data-testid="service-drawer-is-addon"
            />
            <span className="flex-1">
              <span className="block font-medium">
                {language === "vi" ? "Đây là add-on" : "This is an add-on"}
              </span>
              <span className="mt-0.5 block text-xs text-nq-muted">
                {language === "vi"
                  ? "Ẩn khỏi danh sách dịch vụ chính; chỉ gợi ý thêm ở bước Xem lại."
                  : "Hidden from the main service list; offered only as an upsell at review."}
              </span>
            </span>
          </label>

          {/* Add-on timing — only when this is an add-on. */}
          {isAddon ? (
            <label className="block text-sm font-medium text-nq-muted">
              {language === "vi" ? "Thời điểm làm add-on" : "Add-on timing"}
              <select
                className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
                value={addonTiming}
                disabled={isSaving}
                onChange={(e) =>
                  setAddonTiming(
                    e.target.value === "concurrent" ? "concurrent" : "sequential",
                  )
                }
                data-testid="service-drawer-addon-timing"
              >
                <option value="concurrent">
                  {language === "vi"
                    ? "Làm cùng lúc dịch vụ chính (+0 phút)"
                    : "During the service (+0 time)"}
                </option>
                <option value="sequential">
                  {language === "vi"
                    ? "Làm sau khi xong (cộng thêm giờ)"
                    : "After the service (adds time)"}
                </option>
              </select>
              <span className="mt-1 block text-xs text-nq-muted/80">
                {language === "vi"
                  ? "“Cùng lúc” = khách chồng nhiều add-on không tốn thêm thời gian."
                  : "“During” lets customers stack add-ons with no extra time."}
              </span>
            </label>
          ) : null}
        </div>
      </Drawer>
    </>
  );
}

// ── error mapping (same logic as ServicesSetupPanel) ─────────────────────────

function mapUpdateError(
  code: string,
  formLabels: ReturnType<typeof getUserMessages>["serviceForm"],
): string {
  if (code === "invalid_name") return "Fix the name and try again.";
  if (code === "invalid_description") return formLabels.descriptionTooLong;
  if (code === "not_found") return "Could not update that row.";
  return "Could not save. Try again.";
}
