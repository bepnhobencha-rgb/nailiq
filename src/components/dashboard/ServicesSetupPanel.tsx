"use client";

import * as ErrorReporter from "@/shared/observability/errorReporter";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SetupToast, type SetupToastPayload } from "@/components/ui/Toast";
import {
  addService,
  deleteService,
  updateService,
} from "@/shared/dashboard/setupActions";
import type { ServiceCategorySummary } from "@/shared/booking/loadServiceCategories";
import { type ServiceCategory } from "@/shared/booking/serviceCategory";
import { SERVICE_DESCRIPTION_MAX_LEN } from "@/shared/dashboard/serviceConstraints";
import { getUserMessages, type UserMessages } from "@/shared/i18n/user";
import { formatServicePrice, type Currency } from "@/shared/lib/currencyFormat";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { cn } from "@/shared/lib/cn";

// ── ServiceDrawer — built in parallel, imported by interface contract ─────────
import { ServiceDrawer } from "@/components/dashboard/ServiceDrawer";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SetupServiceRow = {
  id: string;
  name: string;
  price_cents: number;
  price_type: string;
  price_max_cents: number | null;
  duration_minutes: number;
  buffer_minutes: number;
  prep_minutes: number;
  category: ServiceCategory;
  description: string | null;
  is_popular: boolean;
  is_featured: boolean;
  is_addon: boolean;
  addon_timing: "concurrent" | "sequential";
};

type ServiceFormLabels = UserMessages["serviceForm"];

// ── Helpers ───────────────────────────────────────────────────────────────────

function centsFromDollarsString(raw: string): number | null {
  const normalized = raw.replace(/[^0-9.]/g, "");
  const n = Number.parseFloat(normalized);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function dollarsFromCents(cents: number): string {
  return (Math.round(cents) / 100).toFixed(2);
}

const UNDO_TIMEOUT_MS = 5000;

function restoreServiceRow(
  rows: SetupServiceRow[],
  row: SetupServiceRow,
  initialRows: SetupServiceRow[],
): SetupServiceRow[] {
  // A server action can stream fresh `initialRows` into this client component
  // before the local rejection handler runs. In that case the service is
  // already back and appending it again would render duplicate rows/buttons.
  if (rows.some((candidate) => candidate.id === row.id)) return rows;

  const originalIndex = initialRows.findIndex(
    (candidate) => candidate.id === row.id,
  );
  const restored = [...rows];
  if (originalIndex >= 0) {
    restored.splice(Math.min(originalIndex, restored.length), 0, row);
  } else {
    restored.push(row);
  }
  return restored;
}

// ── Category icons ─────────────────────────────────────────────────────────────

const CATEGORY_ICONS: Record<string, string> = {
  manicure: "💅",
  pedicure: "🦶",
  acrylic: "✨",
  gel: "💎",
  dip_powder: "🌟",
  removal: "🧹",
  waxing: "🪮",
  eyelashes: "👁️",
  other: "🎨",
};

function getCategoryIcon(cat: string): string {
  return CATEGORY_ICONS[cat] ?? "💄";
}

// ── Error mappers (kept from original) ────────────────────────────────────────

function mapUpdateError(
  code: string,
  messages: {
    invalidName: string;
    descriptionTooLong: string;
    updateRowFailed: string;
    saveFailed: string;
  },
): string {
  if (code === "invalid_name") return messages.invalidName;
  if (code === "invalid_description") return messages.descriptionTooLong;
  if (code === "not_found") return messages.updateRowFailed;
  return messages.saveFailed;
}

function mapDeleteError(
  code: string,
  messages: {
    serviceInUse: string;
    minServiceRequired: string;
    deleteFailed: string;
  },
): string {
  if (code === "minimum_services") return messages.minServiceRequired;
  if (code === "service_in_use" || code === "in_use")
    return messages.serviceInUse;
  return messages.deleteFailed;
}

// ── DescriptionField (kept for ServiceDrawer usage) ───────────────────────────

/** Description textarea with a live character counter. Used by ServiceDrawer. */
export function DescriptionField({
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

// ── PopularToggle (kept for ServiceDrawer usage) ──────────────────────────────

/** "Popular" checkbox toggle. Renders a small gold badge on the public booking
 *  page when checked (see BookingFlowServicePanel). */
export function PopularToggle({
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

// ── PriceChip — inline-editable price cell ────────────────────────────────────

function PriceChip({
  row,
  disabled,
  onSave,
  currency,
}: {
  row: SetupServiceRow;
  disabled: boolean;
  onSave: (cents: number) => void;
  currency: Currency;
}) {
  const [editing, setEditing] = useState(false);
  // Only read while editing. The button below re-seeds it from the row on
  // every click, and the read-only display formats row.price_cents directly,
  // so the row prop never needs syncing into it from an effect.
  const [draft, setDraft] = useState(dollarsFromCents(row.price_cents));
  const inputRef = useRef<HTMLInputElement>(null);

  function handleCommit() {
    const cents = centsFromDollarsString(draft);
    if (cents !== null && cents !== row.price_cents) {
      onSave(cents);
    } else {
      // Revert to original display value on invalid or unchanged input
      setDraft(dollarsFromCents(row.price_cents));
    }
    setEditing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Ignore Enter while an IME composition is active (consistency w/ text fields).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      handleCommit();
    }
    if (e.key === "Escape") {
      setDraft(dollarsFromCents(row.price_cents));
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        autoFocus
        className="w-20 rounded-lg border border-nq-primary/70 bg-nq-bg px-2 py-1 text-sm tabular-nums text-nq-foreground outline-none focus:border-nq-primary"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={handleCommit}
        onKeyDown={handleKeyDown}
      />
    );
  }

  // Display string honours the service's pricing model (fixed / from / range).
  // The inline edit input above still edits only price_cents (the base/min).
  const display =
    formatServicePrice(row.price_cents, currency, {
      priceType: row.price_type,
      priceMaxCents: row.price_max_cents,
    }) ?? `${currency} ${dollarsFromCents(row.price_cents)}`;
  const isZeroPrice = row.price_cents === 0;

  return (
    <button
      type="button"
      title="Click to edit price"
      disabled={disabled}
      className={cn(
        "rounded-lg border border-nq-border/40 bg-nq-surface/60 px-2 py-1 text-sm tabular-nums transition-colors",
        "hover:border-nq-primary/50 hover:bg-nq-primary/5 disabled:cursor-not-allowed disabled:opacity-50",
        isZeroPrice ? "text-nq-warning" : "text-nq-foreground",
      )}
      onClick={() => {
        setDraft(dollarsFromCents(row.price_cents));
        setEditing(true);
      }}
    >
      {display}
    </button>
  );
}

// ── BulkPricePanel — bulk price update when multiple rows selected ─────────────

type BulkMode = "increase" | "decrease" | "set";

function BulkPricePanel({
  selectedCount,
  onApply,
  onClear,
}: {
  selectedCount: number;
  onApply: (mode: BulkMode, amountCents: number) => void;
  onClear: () => void;
}) {
  const [mode, setMode] = useState<BulkMode>("increase");
  const [amount, setAmount] = useState("");
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div
        data-testid="services-bulk-price-panel"
        className="fixed bottom-20 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border border-nq-border/50 bg-nq-surface px-4 py-2.5 shadow-lg text-sm xl:bottom-6"
      >
        <span className="text-nq-muted">
          <strong className="text-nq-foreground">{selectedCount}</strong> dịch vụ đã chọn
        </span>
        <button
          type="button"
          className="flex min-h-11 touch-manipulation items-center rounded-full bg-nq-primary px-3 text-xs font-semibold text-white"
          onClick={() => setOpen(true)}
        >
          Cập nhật giá
        </button>
        <button
          type="button"
          className="min-h-11 touch-manipulation rounded-full px-2 text-xs text-nq-muted hover:text-nq-foreground"
          onClick={onClear}
        >
          Bỏ chọn
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="services-bulk-price-panel"
      className="fixed bottom-20 left-1/2 z-40 w-[min(100vw-2rem,22rem)] -translate-x-1/2 rounded-2xl border border-nq-border/50 bg-nq-surface px-4 py-4 shadow-lg xl:bottom-6"
    >
      <p className="mb-3 text-sm font-semibold text-nq-foreground">
        Cập nhật giá cho {selectedCount} dịch vụ
      </p>
      <div className="flex flex-col gap-2">
        {(["increase", "decrease", "set"] as BulkMode[]).map((m) => (
          <label
            key={m}
            className="flex min-h-11 cursor-pointer touch-manipulation items-center gap-3 rounded-xl px-2 text-sm text-nq-foreground hover:bg-nq-bg/70"
          >
            <input
              type="radio"
              name="bulk-mode"
              value={m}
              checked={mode === m}
              onChange={() => setMode(m)}
              className="h-5 w-5 accent-nq-primary"
            />
            {m === "increase" ? "Tăng $" : m === "decrease" ? "Giảm $" : "Đặt về $"}
          </label>
        ))}
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          className="mt-1 min-h-11 rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2 text-base outline-none focus-visible:border-nq-primary/75"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <div className="mt-1 flex gap-2">
          <button
            type="button"
            className="min-h-11 flex-1 touch-manipulation rounded-xl bg-nq-primary px-4 text-sm font-semibold text-white disabled:opacity-50"
            disabled={centsFromDollarsString(amount) === null}
            onClick={() => {
              const cents = centsFromDollarsString(amount);
              if (cents === null) return;
              onApply(mode, cents);
              setOpen(false);
              setAmount("");
            }}
          >
            Áp dụng
          </button>
          <button
            type="button"
            className="min-h-11 touch-manipulation rounded-xl border border-nq-border/50 px-4 text-sm text-nq-muted"
            onClick={() => setOpen(false)}
          >
            Hủy
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────────

export function ServicesSetupPanel({
  slug,
  initialRows,
  maxServices,
  currency,
  categories,
  multiServiceEditorEnabled,
}: {
  slug: string;
  initialRows: SetupServiceRow[];
  /** Server-resolved cap (from `getEffectivePlanLimits`). `Infinity`
   *  for unlimited plans / feature-flag overrides. Server still
   *  re-validates on every `addService` call. */
  maxServices: number;
  /** Salon's display currency. Drives the price chips and labels. */
  currency: Currency;
  /** Live category list from `loadServiceCategories`. */
  categories: readonly ServiceCategorySummary[];
  /** Effective platform+salon gate. Readiness joins this before rollout. */
  multiServiceEditorEnabled: boolean;
}) {
  const { language } = useUserLanguage();
  const messages = getUserMessages(language);
  const setupErrors = messages.setupErrors;
  const formLabels = messages.serviceForm;
  const tLabels = messages.setupLabels;

  const router = useRouter();
  const [rows, setRows] = useState<SetupServiceRow[]>(initialRows);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [toast, setToast] = useState<SetupToastPayload | null>(null);

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerService, setDrawerService] = useState<SetupServiceRow | null>(null);

  // Search + filter
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  // Undo-delete state
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [undoPending, setUndoPending] = useState<{
    row: SetupServiceRow;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  // Selection for bulk ops
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Sync rows from server
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- server list after refresh
    setRows(initialRows);
  }, [initialRows]);

  const refresh = useCallback(() => router.refresh(), [router]);

  // "Any mutation in flight" guard
  const isMutating = pendingId !== null;

  // Plan-cap gate (UX only — server re-validates)
  const atServiceLimit =
    Number.isFinite(maxServices) && rows.length >= maxServices;

  // ── handleUpdate (unchanged logic) ──────────────────────────────────────────
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
          | "prep_minutes"
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
        ErrorReporter.captureMessage(
          "[ServicesSetupPanel] updateService threw",
          {
            level: "error",
            tags: { "salon.action": "update_service", "salon.slug": slug },
            extra: { serviceId, patch, error: String(err) },
          },
        );
        setPendingId(null);
        setFormError(tLabels.saveFailed);
        setToast({ variant: "error", message: tLabels.saveConnectionFailed });
        return;
      }
      setPendingId(null);
      if (!res.ok) {
        setFormError(
          mapUpdateError(res.error, {
            invalidName: tLabels.invalidName,
            descriptionTooLong: formLabels.descriptionTooLong,
            updateRowFailed: tLabels.updateRowFailed,
            saveFailed: tLabels.saveFailed,
          }),
        );
        setToast({ variant: "error", message: tLabels.saveConnectionFailed });
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
                ...(patch.prep_minutes !== undefined
                  ? { prep_minutes: patch.prep_minutes }
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
      setToast(
        res.descriptionGenerated
          ? {
              variant: "success",
              message: formLabels.descriptionGeneratedToast,
            }
          : { variant: "success", message: tLabels.serviceSaved },
      );
      refresh();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- formLabels and tLabels.serviceSaved are message strings that don't change within a session
    [formLabels.descriptionGeneratedToast, refresh, slug],
  );

  // ── handleDeleteOptimistic — optimistic remove + undo window ─────────────────
  const handleDeleteOptimistic = useCallback(
    (serviceId: string) => {
      // Clear any previous undo pending for a different row
      if (undoTimerRef.current !== null) {
        clearTimeout(undoTimerRef.current);
        undoTimerRef.current = null;
      }
      // If there was a previous undo pending that hasn't fired yet,
      // fire the real delete immediately for the previous row before
      // starting the new undo window
      if (undoPending !== null) {
        const prevId = undoPending.row.id;
        const prevSlug = slug;
        void deleteService(prevSlug, prevId).catch(() => {
          // Best-effort: if this fails we accept the ghost row
        });
      }

      const rowToDelete = rows.find((r) => r.id === serviceId);
      if (!rowToDelete) return;

      // Optimistically remove from UI
      setRows((prev) => prev.filter((r) => r.id !== serviceId));

      // Set up undo window
      const timer = setTimeout(async () => {
        setUndoPending(null);
        undoTimerRef.current = null;
        // Commit the real delete
        setFormError(null);
        setPendingId(serviceId);
        let res: Awaited<ReturnType<typeof deleteService>>;
        try {
          res = await deleteService(slug, serviceId);
        } catch (err) {
          ErrorReporter.captureMessage(
            "[ServicesSetupPanel] deleteService threw",
            {
              level: "error",
              tags: { "salon.action": "delete_service", "salon.slug": slug },
              extra: { serviceId, error: String(err) },
            },
          );
          setPendingId(null);
          // Restore the row on error
          setRows((prev) =>
            restoreServiceRow(prev, rowToDelete, initialRows),
          );
          setFormError(tLabels.deleteFailed);
          setToast({ variant: "error", message: tLabels.saveConnectionFailed });
          return;
        }
        setPendingId(null);
        if (!res.ok) {
          setFormError(
            mapDeleteError(res.error, {
              serviceInUse: setupErrors.serviceInUse,
              minServiceRequired: tLabels.minServiceRequired,
              deleteFailed: tLabels.deleteFailed,
            }),
          );
          setToast({ variant: "error", message: tLabels.saveConnectionFailed });
          // Restore the row on server-side error
          setRows((prev) =>
            restoreServiceRow(prev, rowToDelete, initialRows),
          );
          return;
        }
        setToast({ variant: "success", message: tLabels.serviceRemoved });
        refresh();
      }, UNDO_TIMEOUT_MS);

      undoTimerRef.current = timer;
      setUndoPending({ row: rowToDelete, timer });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tLabels.serviceRemoved is a message string that doesn't change within a session
    [rows, undoPending, slug, setupErrors, refresh, initialRows],
  );

  const handleUndoDelete = useCallback(() => {
    if (undoPending === null) return;
    clearTimeout(undoPending.timer);
    undoTimerRef.current = null;
    // Restore the row
    setRows((prev) =>
      restoreServiceRow(prev, undoPending.row, initialRows),
    );
    setUndoPending(null);
  }, [initialRows, undoPending]);

  // Cleanup timer on unmount
  useEffect(
    () => () => {
      if (undoTimerRef.current !== null) clearTimeout(undoTimerRef.current);
    },
    [],
  );

  // ── Bulk price update ────────────────────────────────────────────────────────
  const handleBulkPrice = useCallback(
    async (mode: BulkMode, amountCents: number) => {
      const ids = Array.from(selectedIds);
      for (const id of ids) {
        const row = rows.find((r) => r.id === id);
        if (!row) continue;
        let newCents: number;
        if (mode === "increase") newCents = row.price_cents + amountCents;
        else if (mode === "decrease")
          newCents = Math.max(0, row.price_cents - amountCents);
        else newCents = amountCents;
        await handleUpdate(id, { price_cents: newCents });
      }
      setSelectedIds(new Set());
    },
    [selectedIds, rows, handleUpdate],
  );

  // ── Filtered + grouped rows ───────────────────────────────────────────────────
  const filteredRows = rows.filter((r) => {
    const matchesSearch = r.name
      .toLowerCase()
      .includes(search.toLowerCase());
    const matchesCat =
      activeCategory === null || r.category === activeCategory;
    return matchesSearch && matchesCat;
  });

  // Deduplicated categories in order of first appearance
  const uniqueCategories: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!seen.has(r.category)) {
      seen.add(r.category);
      uniqueCategories.push(r.category);
    }
  }

  // Group filtered rows by category (only when showing all)
  const grouped: { cat: string; items: SetupServiceRow[] }[] = [];
  if (activeCategory === null) {
    const map = new Map<string, SetupServiceRow[]>();
    for (const r of filteredRows) {
      const bucket = map.get(r.category) ?? [];
      bucket.push(r);
      map.set(r.category, bucket);
    }
    for (const cat of uniqueCategories) {
      const items = map.get(cat);
      if (items && items.length > 0) grouped.push({ cat, items });
    }
  } else {
    grouped.push({ cat: activeCategory, items: filteredRows });
  }

  // Category label helper
  function getCategoryLabel(cat: string): string {
    const found = categories.find((c) => c.slug === cat);
    if (!found) return cat;
    return language === "vi" ? found.nameVi : found.nameEn;
  }

  // ── Toggle row selection ──────────────────────────────────────────────────────
  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <SetupToast toast={toast} onDismiss={() => setToast(null)} />

      {formError ? (
        <p className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error">
          {formError}
        </p>
      ) : null}

      {/* ── Header row: title + "Thêm" button (sticky at top) ───────────────── */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-nq-foreground">
          {tLabels.servicesTitle} · {rows.length}
        </h2>
        <div className="flex items-center gap-2">
          {atServiceLimit ? (
            <Link
              href={`/dashboard/${encodeURIComponent(slug)}/settings`}
              className="text-xs font-medium text-nq-primary hover:underline underline-offset-2"
              data-testid="service-at-limit-upgrade-link"
            >
              {setupErrors.upgradeCta}
            </Link>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            disabled={atServiceLimit || isMutating}
            onClick={() => {
              setDrawerService(null);
              setDrawerOpen(true);
            }}
          >
            + {tLabels.addService}
          </Button>
        </div>
      </div>

      {/* Plan-limit banner (when at limit) */}
      {atServiceLimit ? (
        <p
          className="rounded-xl border border-nq-primary/30 bg-nq-primary/10 px-3 py-2 text-sm text-nq-foreground"
          role="status"
          data-testid="service-at-limit-banner"
        >
          {setupErrors.serviceLimitReached}{" "}
          <Link
            href={`/dashboard/${encodeURIComponent(slug)}/settings`}
            className="font-semibold text-nq-primary hover:text-nq-primary/85 underline-offset-2 hover:underline"
          >
            {setupErrors.upgradeCta}
          </Link>
        </p>
      ) : null}

      {/* ── AI import banner — shown when service list is empty ─────────────── */}
      {rows.length === 0 && (
        <div className="flex flex-col gap-3 rounded-2xl border border-nq-primary/40 bg-nq-primary/[0.05] px-4 py-4">
          <div className="flex items-start gap-3">
            <span aria-hidden className="text-2xl">✨</span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-nq-foreground">
                {messages.aiPrefill.bannerTitle}
              </p>
              <p className="mt-0.5 text-sm text-nq-muted">
                {messages.aiPrefill.bannerSubtitle}
              </p>
            </div>
          </div>
          <Link
            href={`/dashboard/${encodeURIComponent(slug)}/setup/ai-prefill`}
            className="inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-nq-primary px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/50"
          >
            {messages.aiPrefill.bannerCta}
          </Link>
        </div>
      )}

      {/* ── Search bar ──────────────────────────────────────────────────────── */}
      {rows.length > 0 && (
        <input
          type="search"
          placeholder={`🔍 ${tLabels.searchServices}`}
          className="w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-4 py-2.5 text-base text-nq-foreground outline-none focus-visible:border-nq-primary/75"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}

      {/* ── Category filter chips ────────────────────────────────────────────── */}
      {uniqueCategories.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setActiveCategory(null)}
            className={cn(
              "rounded-full border px-3 py-1 text-sm font-medium transition-colors",
              activeCategory === null
                ? "border-nq-primary bg-nq-primary text-white"
                : "border-nq-border/50 text-nq-muted hover:border-nq-primary/50",
            )}
          >
            Tất cả
          </button>
          {uniqueCategories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() =>
                setActiveCategory(activeCategory === cat ? null : cat)
              }
              className={cn(
                "rounded-full border px-3 py-1 text-sm font-medium transition-colors",
                activeCategory === cat
                  ? "border-nq-primary bg-nq-primary text-white"
                  : "border-nq-border/50 text-nq-muted hover:border-nq-primary/50",
              )}
            >
              {getCategoryIcon(cat)} {getCategoryLabel(cat)}
            </button>
          ))}
        </div>
      )}

      {/* ── Service list grouped by category ─────────────────────────────────── */}
      {grouped.length === 0 && rows.length > 0 ? (
        <p className="py-6 text-center text-sm text-nq-muted">
          Không tìm thấy dịch vụ nào.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {grouped.map(({ cat, items }) => (
            <div key={cat}>
              {/* Category header (only when showing all categories) */}
              {activeCategory === null && (
                <div className="px-1 py-1.5 text-xs font-semibold uppercase tracking-wide text-nq-muted/70">
                  {getCategoryIcon(cat)} {getCategoryLabel(cat)}
                </div>
              )}
              {/* Rows card */}
              <div className="overflow-hidden rounded-2xl border border-nq-border/40 bg-nq-surface/40">
                {items.map((row, idx) => (
                  <ServiceRow
                    key={row.id}
                    row={row}
                    currency={currency}
                    isLast={idx === items.length - 1}
                    pendingId={pendingId}
                    selected={selectedIds.has(row.id)}
                    onToggleSelect={() => toggleSelect(row.id)}
                    onEdit={() => {
                      setDrawerService(row);
                      setDrawerOpen(true);
                    }}
                    onDelete={() => handleDeleteOptimistic(row.id)}
                    onPriceSave={(cents) =>
                      void handleUpdate(row.id, { price_cents: cents })
                    }
                    canDelete={rows.length > 1}
                    editLabel={tLabels.editService}
                    removeLabel={tLabels.deleteService}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Bulk price bar (when rows selected) ──────────────────────────────── */}
      {selectedIds.size > 0 && (
        <BulkPricePanel
          selectedCount={selectedIds.size}
          onApply={(mode, amountCents) => void handleBulkPrice(mode, amountCents)}
          onClear={() => setSelectedIds(new Set())}
        />
      )}

      {/* ── Undo delete toast ─────────────────────────────────────────────────── */}
      {undoPending && (
        <div className="fixed bottom-20 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-nq-border/50 bg-nq-surface px-4 py-2.5 shadow-lg text-sm xl:bottom-6">
          <span>
            {tLabels.removed} <strong>{undoPending.row.name}</strong>
          </span>
          <button
            type="button"
            onClick={handleUndoDelete}
            className="min-h-11 touch-manipulation rounded-full px-3 font-semibold text-nq-primary"
          >
            ↺ {tLabels.undo}
          </button>
        </div>
      )}

      {/* ── ServiceDrawer (add + edit) ────────────────────────────────────────── */}
      <ServiceDrawer
        slug={slug}
        service={drawerService}
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSaved={(updated) => {
          setRows((prev) =>
            prev.map((r) => (r.id === updated.id ? updated : r)),
          );
          setDrawerOpen(false);
          setToast({ variant: "success", message: tLabels.serviceSaved });
        }}
        onAdded={() => {
          refresh();
          setDrawerOpen(false);
          setToast({ variant: "success", message: tLabels.serviceSaved });
        }}
        onRequestDelete={(id) => {
          setDrawerOpen(false);
          handleDeleteOptimistic(id);
        }}
        currency={currency}
        categories={categories}
        canDelete={rows.length > 1}
        atServiceLimit={atServiceLimit}
        multiServiceEditorEnabled={multiServiceEditorEnabled}
      />
    </div>
  );
}

// ── ServiceRow — compact row component ────────────────────────────────────────

function ServiceRow({
  row,
  currency,
  isLast,
  pendingId,
  selected,
  onToggleSelect,
  onEdit,
  onDelete,
  onPriceSave,
  canDelete,
  editLabel,
  removeLabel,
}: {
  row: SetupServiceRow;
  currency: Currency;
  isLast: boolean;
  pendingId: string | null;
  selected: boolean;
  onToggleSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onPriceSave: (cents: number) => void;
  canDelete: boolean;
  editLabel: string;
  removeLabel: string;
}) {
  const isPending = pendingId === row.id;

  return (
    <div
      className={cn(
        "group flex min-h-[52px] items-center gap-2 px-3 py-2 transition-colors hover:bg-nq-surface/70",
        !isLast && "border-b border-nq-border/30",
      )}
    >
      {/* Checkbox — visible on hover (desktop) or always (mobile) */}
      <div className="flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100 sm:block hidden">
        <input
          type="checkbox"
          className="h-4 w-4 cursor-pointer accent-nq-primary"
          checked={selected}
          onChange={onToggleSelect}
          aria-label={`Select ${row.name}`}
        />
      </div>
      {/* Always visible checkbox on mobile */}
      <div className="flex-shrink-0 sm:hidden block">
        <input
          type="checkbox"
          className="h-4 w-4 cursor-pointer accent-nq-primary"
          checked={selected}
          onChange={onToggleSelect}
          aria-label={`Select ${row.name}`}
        />
      </div>

      {/* Category icon */}
      <span aria-hidden className="flex-shrink-0 text-base leading-none">
        {getCategoryIcon(row.category)}
      </span>

      {/* Service name */}
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-nq-foreground">
        {row.name}
        {row.is_popular && (
          <span className="ml-1.5 inline-block rounded-full bg-nq-primary/15 px-1.5 py-px text-[10px] font-semibold text-nq-primary">
            ★
          </span>
        )}
      </span>

      {/* Price chip (inline editable) */}
      <div className="flex-shrink-0">
        {isPending ? (
          <span className="inline-flex items-center gap-1 rounded-lg border border-nq-border/40 bg-nq-surface/60 px-2 py-1 text-sm tabular-nums text-nq-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-nq-primary animate-pulse" />
            {formatServicePrice(row.price_cents, currency, {
              priceType: row.price_type,
              priceMaxCents: row.price_max_cents,
            }) ?? `${currency} ${dollarsFromCents(row.price_cents)}`}
          </span>
        ) : (
          <PriceChip
            row={row}
            disabled={pendingId !== null}
            onSave={onPriceSave}
            currency={currency}
          />
        )}
      </div>

      {/* Duration chip */}
      <span className="flex-shrink-0 text-sm text-nq-muted tabular-nums hidden sm:block">
        {row.duration_minutes}&nbsp;min
      </span>

      {/* Edit button */}
      <button
        type="button"
        title={editLabel}
        aria-label={`${editLabel} — ${row.name}`}
        data-testid={`service-edit-${row.id}`}
        disabled={pendingId !== null}
        className="flex-shrink-0 rounded-lg p-1.5 text-nq-muted transition-colors hover:bg-nq-surface hover:text-nq-foreground disabled:opacity-50"
        onClick={onEdit}
      >
        ✏️
      </button>

      {/* Delete button */}
      <button
        type="button"
        title={removeLabel}
        aria-label={`${removeLabel} — ${row.name}`}
        data-testid={`service-delete-${row.id}`}
        disabled={pendingId !== null || !canDelete}
        className="flex-shrink-0 rounded-lg p-1.5 text-nq-muted transition-colors hover:bg-nq-error/10 hover:text-nq-error disabled:opacity-50"
        onClick={onDelete}
      >
        🗑️
      </button>
    </div>
  );
}
