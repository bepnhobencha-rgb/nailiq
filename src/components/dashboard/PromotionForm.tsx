"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/shared/lib/cn";
import { formatServicePrice } from "@/shared/lib/currencyFormat";
import type { PromotionRow, PromotionServiceRow, PromotionFormData } from "@/app/dashboard/[slug]/setup/promotions/actions";

type Service = { id: string; name: string; price_cents: number | null };

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Props = {
  initial: PromotionRow | null;
  initialSvcRules: PromotionServiceRow[];
  services: Service[];
  onSave: (data: PromotionFormData) => Promise<void>;
  onCancel: () => void;
};

export function PromotionForm({ initial, initialSvcRules, services, onSave, onCancel }: Props) {
  const toDateInput = (iso: string) => iso ? iso.slice(0, 10) : "";

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [startsAt, setStartsAt] = useState(toDateInput(initial?.starts_at ?? ""));
  const [endsAt, setEndsAt] = useState(toDateInput(initial?.ends_at ?? ""));
  const [discountType, setDiscountType] = useState<"fixed_price" | "percent" | "amount">(
    (initial?.discount_type as "fixed_price" | "percent" | "amount") ?? "fixed_price",
  );
  const [appliesTo, setAppliesTo] = useState<"all" | "specific">(
    (initial?.applies_to as "all" | "specific") ?? "specific",
  );
  const [active, setActive] = useState(initial?.active ?? true);

  // Schedule
  const [useSchedule, setUseSchedule] = useState(
    !!(initial?.days_of_week?.length || initial?.time_start),
  );
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(initial?.days_of_week ?? []);
  const [timeStart, setTimeStart] = useState(initial?.time_start ?? "");
  const [timeEnd, setTimeEnd] = useState(initial?.time_end ?? "");

  // Per-service discount values (keyed by service_id)
  const [selectedServices, setSelectedServices] = useState<Set<string>>(
    new Set(initialSvcRules.map((r) => r.service_id)),
  );
  const [svcOverrides, setSvcOverrides] = useState<Record<string, { value: string }>>(
    Object.fromEntries(
      initialSvcRules.map((r) => [
        r.service_id,
        { value: r.discount_value != null ? String(r.discount_value / 100) : "" },
      ]),
    ),
  );

  const [saving, setSaving] = useState(false);

  function toggleDay(d: number) {
    setDaysOfWeek((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]);
  }

  function toggleService(id: string) {
    setSelectedServices((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function getSvcPromoPrice(svc: Service): string {
    const base = svc.price_cents ?? 0;
    const override = svcOverrides[svc.id]?.value;
    const val = parseFloat(override ?? "");
    if (!base || isNaN(val) || val <= 0) return "";
    if (discountType === "fixed_price") {
      return `$${(base / 100).toFixed(2)} → $${val.toFixed(2)}`;
    }
    if (discountType === "amount") {
      return `$${(base / 100).toFixed(2)} → $${((base - val * 100) / 100).toFixed(2)}`;
    }
    if (discountType === "percent") {
      return `$${(base / 100).toFixed(2)} → $${((base * (1 - val / 100)) / 100).toFixed(2)}`;
    }
    return "";
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);

    const svcList = Array.from(selectedServices).map((id) => {
      const override = svcOverrides[id]?.value;
      const val = parseFloat(override ?? "");
      const hasOverride = !isNaN(val) && val > 0;
      return {
        service_id: id,
        discount_type: hasOverride ? discountType : null,
        discount_value: hasOverride
          ? discountType === "percent"
            ? Math.round(val * 100)
            : Math.round(val * 100)
          : null,
      };
    });

    await onSave({
      name,
      description: description || null,
      starts_at: startsAt ? `${startsAt}T00:00:00Z` : "",
      ends_at: endsAt ? `${endsAt}T23:59:59Z` : "",
      discount_type: discountType,
      discount_value: 0,
      applies_to: appliesTo,
      active,
      days_of_week: useSchedule && daysOfWeek.length > 0 ? daysOfWeek : null,
      time_start: useSchedule && timeStart ? timeStart : null,
      time_end: useSchedule && timeEnd ? timeEnd : null,
      services: svcList,
    });
    setSaving(false);
  }

  const inputCls = "w-full rounded-lg border border-nq-border bg-nq-surface-raised px-3 py-2 text-sm text-nq-foreground placeholder:text-nq-foreground-muted focus:border-nq-primary focus:outline-none";
  const labelCls = "mb-1.5 block text-sm font-medium text-nq-foreground";

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Name */}
      <div>
        <label className={labelCls}>Campaign name *</label>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Summer Special 2025"
          className={inputCls}
        />
      </div>

      {/* Description */}
      <div>
        <label className={labelCls}>Description (optional)</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Beat the heat — save on all treatments"
          className={inputCls}
        />
      </div>

      {/* Date range */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Start date *</label>
          <input
            required
            type="date"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>End date *</label>
          <input
            required
            type="date"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            className={inputCls}
          />
        </div>
      </div>

      {/* Discount type */}
      <div>
        <label className={labelCls}>Discount type *</label>
        <div className="flex gap-2">
          {(["fixed_price", "amount", "percent"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setDiscountType(t)}
              className={cn(
                "flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                discountType === t
                  ? "border-nq-primary bg-nq-primary/10 text-nq-primary"
                  : "border-nq-border bg-nq-surface-raised text-nq-foreground-muted hover:border-nq-primary/40",
              )}
            >
              {t === "fixed_price" ? "Fixed price" : t === "amount" ? "$ off" : "% off"}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-nq-foreground-muted">
          {discountType === "fixed_price" && "Set the exact new price per service (e.g. $90 instead of $105)"}
          {discountType === "amount" && "Subtract a flat dollar amount from the service price"}
          {discountType === "percent" && "Percentage off (e.g. 20% off every service in this campaign)"}
        </p>
      </div>

      {/* Applies to */}
      <div>
        <label className={labelCls}>Applies to</label>
        <div className="flex gap-2">
          {(["specific", "all"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setAppliesTo(t)}
              className={cn(
                "flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                appliesTo === t
                  ? "border-nq-primary bg-nq-primary/10 text-nq-primary"
                  : "border-nq-border bg-nq-surface-raised text-nq-foreground-muted hover:border-nq-primary/40",
              )}
            >
              {t === "specific" ? "Specific services" : "All services"}
            </button>
          ))}
        </div>
      </div>

      {/* Service list (when specific) */}
      {appliesTo === "specific" && (
        <div>
          <label className={labelCls}>Services in this campaign</label>
          <div className="max-h-72 overflow-y-auto rounded-xl border border-nq-border bg-nq-surface">
            {services.map((svc) => {
              const checked = selectedServices.has(svc.id);
              const preview = getSvcPromoPrice(svc);
              return (
                <div
                  key={svc.id}
                  className={cn(
                    "flex items-center gap-3 border-b border-nq-border/50 px-3 py-2.5 last:border-0 transition-colors",
                    checked ? "bg-nq-primary/5" : "",
                  )}
                >
                  <input
                    id={`svc-${svc.id}`}
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleService(svc.id)}
                    className="h-4 w-4 accent-nq-primary"
                  />
                  <label
                    htmlFor={`svc-${svc.id}`}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
                  >
                    <span className="flex-1 truncate text-sm text-nq-foreground">{svc.name}</span>
                    <span className="shrink-0 text-xs text-nq-foreground-muted">
                      {formatServicePrice(svc.price_cents, "USD", { priceType: "fixed", priceMaxCents: null })}
                    </span>
                  </label>
                  {checked && (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder={discountType === "percent" ? "%" : "$"}
                        value={svcOverrides[svc.id]?.value ?? ""}
                        onChange={(e) =>
                          setSvcOverrides((prev) => ({ ...prev, [svc.id]: { value: e.target.value } }))
                        }
                        className="w-20 rounded-md border border-nq-border bg-nq-surface-raised px-2 py-1 text-right text-sm text-nq-foreground focus:border-nq-primary focus:outline-none"
                      />
                      {preview && (
                        <span className="text-xs text-nq-primary whitespace-nowrap">{preview}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-nq-foreground-muted">
            Enter the{" "}
            {discountType === "fixed_price"
              ? "new promo price (e.g. 90 for $90)"
              : discountType === "amount"
              ? "dollar amount to subtract"
              : "percentage to subtract"}{" "}
            in the field next to each selected service.
          </p>
        </div>
      )}

      {/* Schedule (optional) */}
      <div>
        <div className="flex items-center justify-between">
          <label className={labelCls + " mb-0"}>Schedule (optional)</label>
          <button
            type="button"
            onClick={() => setUseSchedule((v) => !v)}
            className="text-xs text-nq-primary hover:underline"
          >
            {useSchedule ? "Remove" : "Add schedule"}
          </button>
        </div>
        {useSchedule && (
          <div className="mt-2 space-y-3 rounded-xl border border-nq-border bg-nq-surface p-3">
            <div>
              <p className="mb-2 text-xs text-nq-foreground-muted">Days of week (leave blank = every day)</p>
              <div className="flex gap-1">
                {DAY_LABELS.map((d, i) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleDay(i)}
                    className={cn(
                      "h-8 w-9 rounded-md text-xs font-medium transition-colors",
                      daysOfWeek.includes(i)
                        ? "bg-nq-primary text-black"
                        : "border border-nq-border bg-nq-surface-raised text-nq-foreground-muted hover:border-nq-primary/40",
                    )}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-nq-foreground-muted">From</label>
                <input
                  type="time"
                  value={timeStart}
                  onChange={(e) => setTimeStart(e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-nq-foreground-muted">Until</label>
                <input
                  type="time"
                  value={timeEnd}
                  onChange={(e) => setTimeEnd(e.target.value)}
                  className={inputCls}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Active toggle */}
      <div className="flex items-center gap-3">
        <input
          id="promo-active"
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
          className="h-4 w-4 accent-nq-primary"
        />
        <label htmlFor="promo-active" className="text-sm text-nq-foreground">
          Campaign is active
        </label>
      </div>

      {/* Actions */}
      <div className="flex gap-3 pt-1">
        <Button type="submit" disabled={saving} className="flex-1">
          {saving ? "Saving…" : initial ? "Save changes" : "Create campaign"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} className="flex-1">
          Cancel
        </Button>
      </div>
    </form>
  );
}
