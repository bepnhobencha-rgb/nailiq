"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/shared/lib/cn";
import {
  createPromotionAction,
  updatePromotionAction,
  togglePromotionActiveAction,
  deletePromotionAction,
  type PromotionRow,
  type PromotionServiceRow,
  type PromotionFormData,
} from "@/app/dashboard/[slug]/setup/promotions/actions";
import { PromotionForm } from "@/components/dashboard/PromotionForm";

type Service = { id: string; name: string; price_cents: number | null };

type Props = {
  slug: string;
  initialPromos: PromotionRow[];
  initialSvcRules: PromotionServiceRow[];
  services: Service[];
};

export function PromotionsSetupPanel({ slug, initialPromos, initialSvcRules, services }: Props) {
  const [promos, setPromos] = useState<PromotionRow[]>(initialPromos);
  const [svcRules, setSvcRules] = useState<PromotionServiceRow[]>(initialSvcRules);
  const [showForm, setShowForm] = useState(false);
  const [editingPromo, setEditingPromo] = useState<PromotionRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const now = new Date();

  function getPromoStatus(p: PromotionRow): "active" | "upcoming" | "expired" | "paused" {
    if (!p.active) return "paused";
    const start = new Date(p.starts_at);
    const end = new Date(p.ends_at);
    if (now < start) return "upcoming";
    if (now > end) return "expired";
    return "active";
  }

  const statusBadge = {
    active: <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-400">Active</span>,
    upcoming: <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-xs font-medium text-blue-400">Upcoming</span>,
    expired: <span className="rounded-full bg-zinc-500/15 px-2 py-0.5 text-xs font-medium text-zinc-400">Expired</span>,
    paused: <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400">Paused</span>,
  };

  function formatDiscount(p: PromotionRow) {
    if (p.discount_type === "fixed_price") return `Fixed price`;
    if (p.discount_type === "percent") return `${p.discount_value / 100}% off`;
    if (p.discount_type === "amount") return `$${(p.discount_value / 100).toFixed(2)} off`;
    return "";
  }

  function formatDateRange(p: PromotionRow) {
    const fmt = (iso: string) =>
      new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return `${fmt(p.starts_at)} – ${fmt(p.ends_at)}`;
  }

  function getRulesForPromo(promoId: string) {
    return svcRules.filter((r) => r.promotion_id === promoId);
  }

  async function handleSave(data: PromotionFormData) {
    setError(null);
    if (editingPromo) {
      const result = await updatePromotionAction(slug, editingPromo.id, data);
      if (result.error) { setError(result.error); return; }
      setPromos((prev) =>
        prev.map((p) =>
          p.id === editingPromo.id
            ? { ...p, ...data, days_of_week: data.days_of_week ?? null, time_start: data.time_start ?? null, time_end: data.time_end ?? null, description: data.description ?? null }
            : p,
        ),
      );
      setSvcRules((prev) => [
        ...prev.filter((r) => r.promotion_id !== editingPromo.id),
        ...(data.services ?? []).map((s) => ({
          promotion_id: editingPromo.id,
          service_id: s.service_id,
          discount_type: s.discount_type ?? null,
          discount_value: s.discount_value ?? null,
        })),
      ]);
    } else {
      const result = await createPromotionAction(slug, data);
      if (result.error) { setError(result.error); return; }
      if (result.id) {
        const newPromo: PromotionRow = {
          id: result.id,
          name: data.name,
          description: data.description ?? null,
          starts_at: data.starts_at,
          ends_at: data.ends_at,
          discount_type: data.discount_type,
          discount_value: data.discount_value,
          applies_to: data.applies_to,
          active: data.active ?? true,
          days_of_week: data.days_of_week ?? null,
          time_start: data.time_start ?? null,
          time_end: data.time_end ?? null,
        };
        setPromos((prev) => [newPromo, ...prev]);
        setSvcRules((prev) => [
          ...prev,
          ...(data.services ?? []).map((s) => ({
            promotion_id: result.id!,
            service_id: s.service_id,
            discount_type: s.discount_type ?? null,
            discount_value: s.discount_value ?? null,
          })),
        ]);
      }
    }
    setShowForm(false);
    setEditingPromo(null);
  }

  function handleEdit(p: PromotionRow) {
    setEditingPromo(p);
    setShowForm(true);
    setError(null);
  }

  function handleNew() {
    setEditingPromo(null);
    setShowForm(true);
    setError(null);
  }

  function handleToggle(p: PromotionRow) {
    startTransition(async () => {
      await togglePromotionActiveAction(slug, p.id, !p.active);
      setPromos((prev) => prev.map((x) => x.id === p.id ? { ...x, active: !x.active } : x));
    });
  }

  function handleDelete(p: PromotionRow) {
    if (!confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
    startTransition(async () => {
      await deletePromotionAction(slug, p.id);
      setPromos((prev) => prev.filter((x) => x.id !== p.id));
      setSvcRules((prev) => prev.filter((r) => r.promotion_id !== p.id));
    });
  }

  if (showForm) {
    return (
      <div className="space-y-4 px-1">
        <div className="flex items-center gap-3">
          <button
            onClick={() => { setShowForm(false); setEditingPromo(null); }}
            className="text-sm text-nq-foreground-muted hover:text-nq-foreground"
          >
            ← Back
          </button>
          <h2 className="text-lg font-semibold text-nq-foreground">
            {editingPromo ? "Edit Promotion" : "New Promotion"}
          </h2>
        </div>
        {error && (
          <p className="rounded-lg bg-nq-error/10 px-3 py-2 text-sm text-nq-error">{error}</p>
        )}
        <PromotionForm
          initial={editingPromo}
          initialSvcRules={editingPromo ? getRulesForPromo(editingPromo.id) : []}
          services={services}
          onSave={handleSave}
          onCancel={() => { setShowForm(false); setEditingPromo(null); }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5 px-1">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-nq-foreground">Promotions</h2>
          <p className="text-sm text-nq-foreground-muted">
            Time-limited discounts that auto-apply — no code needed.
          </p>
        </div>
        <Button size="sm" onClick={handleNew} className="gap-1.5">
          <span className="text-base leading-none">+</span> New campaign
        </Button>
      </div>

      {promos.length === 0 ? (
        <div className="rounded-xl border border-nq-border bg-nq-surface py-12 text-center">
          <div className="mx-auto mb-3 text-3xl">🏷️</div>
          <p className="font-medium text-nq-foreground">No promotions yet</p>
          <p className="mt-1 text-sm text-nq-foreground-muted">
            Create a campaign to offer time-limited discounts on services.
          </p>
          <Button size="sm" className="mt-4" onClick={handleNew}>
            Create first campaign
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {promos.map((p) => {
            const status = getPromoStatus(p);
            const rules = getRulesForPromo(p.id);
            const serviceNames = rules
              .map((r) => services.find((s) => s.id === r.service_id)?.name)
              .filter(Boolean);

            return (
              <div
                key={p.id}
                className={cn(
                  "rounded-xl border bg-nq-surface p-4 transition-opacity",
                  status === "expired" || status === "paused" ? "opacity-60" : "",
                  status === "active" ? "border-nq-primary/30" : "border-nq-border",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-nq-foreground">{p.name}</span>
                      {statusBadge[status]}
                    </div>
                    <p className="mt-0.5 text-sm text-nq-foreground-muted">
                      {formatDateRange(p)} · {formatDiscount(p)}
                    </p>
                    {p.description && (
                      <p className="mt-0.5 text-xs text-nq-foreground-muted">{p.description}</p>
                    )}
                    {serviceNames.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {serviceNames.slice(0, 5).map((name) => (
                          <span
                            key={name}
                            className="rounded-full bg-nq-surface-raised px-2 py-0.5 text-xs text-nq-foreground-muted"
                          >
                            {name}
                          </span>
                        ))}
                        {serviceNames.length > 5 && (
                          <span className="rounded-full bg-nq-surface-raised px-2 py-0.5 text-xs text-nq-foreground-muted">
                            +{serviceNames.length - 5} more
                          </span>
                        )}
                      </div>
                    )}
                    {p.applies_to === "all" && (
                      <span className="mt-1 inline-block rounded-full bg-nq-primary/10 px-2 py-0.5 text-xs text-nq-primary">
                        All services
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => handleToggle(p)}
                      className="text-xs text-nq-foreground-muted hover:text-nq-foreground"
                    >
                      {p.active ? "Pause" : "Resume"}
                    </button>
                    <button
                      onClick={() => handleEdit(p)}
                      className="text-xs text-nq-primary hover:underline"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(p)}
                      className="text-xs text-nq-error hover:underline"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
