"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/shared/lib/supabase/client";
import type { ComboRow, ServiceOption } from "@/app/dashboard/[slug]/combos/page";
import { cn } from "@/shared/lib/cn";

type EditState = {
  id: string | null;
  name: string;
  description: string;
  service_ids: string[];
  price_cents: string;
  discount_cents: string;
  duration_minutes: string;
  is_active: boolean;
};

const BLANK: EditState = {
  id: null,
  name: "",
  description: "",
  service_ids: [],
  price_cents: "",
  discount_cents: "0",
  duration_minutes: "",
  is_active: true,
};

function formatPrice(cents: number) {
  return `$${(cents / 100).toFixed(0)}`;
}

export function CombosPanel({
  salonId,
  slug,
  combos: initialCombos,
  services,
}: {
  salonId: string;
  slug: string;
  combos: ComboRow[];
  services: ServiceOption[];
}) {
  const router = useRouter();
  const db = createClient();
  const [combos, setCombos] = useState<ComboRow[]>(initialCombos);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openNew = () => setEditing({ ...BLANK });
  const openEdit = (c: ComboRow) =>
    setEditing({
      id: c.id,
      name: c.name,
      description: c.description ?? "",
      service_ids: c.service_ids ?? [],
      price_cents: String(Math.round(c.price_cents / 100)),
      discount_cents: String(Math.round(c.discount_cents / 100)),
      duration_minutes: String(c.duration_minutes),
      is_active: c.is_active,
    });

  const toggleService = (id: string) => {
    if (!editing) return;
    setEditing((e) => {
      if (!e) return e;
      const next = e.service_ids.includes(id)
        ? e.service_ids.filter((s) => s !== id)
        : [...e.service_ids, id];
      // Auto-fill duration as sum of selected services
      const totalMin = services
        .filter((s) => next.includes(s.id))
        .reduce((sum, s) => sum + (s.duration_minutes ?? 0), 0);
      return {
        ...e,
        service_ids: next,
        duration_minutes: totalMin > 0 ? String(totalMin) : e.duration_minutes,
      };
    });
  };

  const save = useCallback(async () => {
    if (!editing) return;
    setError(null);
    const name = editing.name.trim();
    if (!name) { setError("Name is required"); return; }
    if (editing.service_ids.length < 2) { setError("Select at least 2 services"); return; }
    const price = Math.round(parseFloat(editing.price_cents || "0") * 100);
    const discount = Math.round(parseFloat(editing.discount_cents || "0") * 100);
    const duration = parseInt(editing.duration_minutes || "0", 10);
    if (duration <= 0) { setError("Duration must be > 0"); return; }

    setSaving(true);
    const payload = {
      salon_id: salonId,
      name,
      description: editing.description.trim() || null,
      service_ids: editing.service_ids,
      price_cents: price,
      discount_cents: discount,
      duration_minutes: duration,
      is_active: editing.is_active,
    };

    let err;
    let row: ComboRow | null = null;
    if (editing.id) {
      const { data, error: e } = await (db as ReturnType<typeof createClient>)
        .from("service_combos" as never)
        .update(payload as never)
        .eq("id", editing.id)
        .select()
        .single();
      err = e;
      row = data as ComboRow | null;
    } else {
      const maxPos = combos.reduce((m, c) => Math.max(m, c.position), -1);
      const { data, error: e } = await (db as ReturnType<typeof createClient>)
        .from("service_combos" as never)
        .insert({ ...payload, position: maxPos + 1 } as never)
        .select()
        .single();
      err = e;
      row = data as ComboRow | null;
    }

    setSaving(false);
    if (err || !row) { setError((err as { message?: string })?.message ?? "Save failed"); return; }

    setCombos((prev) =>
      editing.id
        ? prev.map((c) => (c.id === editing.id ? (row as ComboRow) : c))
        : [...prev, row as ComboRow],
    );
    setEditing(null);
    router.refresh();
  }, [editing, salonId, combos, db, router]);

  const del = useCallback(async (id: string) => {
    if (!confirm("Delete this bundle?")) return;
    await (db as ReturnType<typeof createClient>)
      .from("service_combos" as never)
      .delete()
      .eq("id", id);
    setCombos((prev) => prev.filter((c) => c.id !== id));
    router.refresh();
  }, [db, router]);

  return (
    <div className="space-y-8 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-nq-text">Service Bundles</h1>
          <p className="mt-1 text-sm text-nq-muted">
            Create bundled packages — clients see them at the top of the service menu.
          </p>
        </div>
        <button
          type="button"
          onClick={openNew}
          className="rounded-xl bg-nq-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
        >
          + New Bundle
        </button>
      </div>

      {combos.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-nq-border p-10 text-center text-nq-muted">
          No bundles yet. Create one to show package deals on your booking page.
        </div>
      ) : (
        <div className="space-y-3">
          {combos.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between rounded-2xl border border-nq-border bg-nq-card p-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-nq-text">{c.name}</span>
                  {!c.is_active && (
                    <span className="rounded-full bg-nq-muted/20 px-2 py-0.5 text-[11px] text-nq-muted">
                      Inactive
                    </span>
                  )}
                  {c.discount_cents > 0 && (
                    <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-semibold text-green-600">
                      Save {formatPrice(c.discount_cents)}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-sm text-nq-muted">
                  {c.duration_minutes} min · {formatPrice(c.price_cents)}
                  {c.service_ids?.length ? ` · ${c.service_ids.length} services` : ""}
                </p>
                {c.description ? (
                  <p className="mt-1 text-xs text-nq-muted line-clamp-1">{c.description}</p>
                ) : null}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => openEdit(c)}
                  className="rounded-lg px-3 py-1.5 text-sm font-medium text-nq-primary hover:bg-nq-primary/10"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void del(c.id)}
                  className="rounded-lg px-3 py-1.5 text-sm font-medium text-red-500 hover:bg-red-50"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Edit / Create modal */}
      {editing ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl dark:bg-nq-card">
            <h2 className="text-lg font-bold text-nq-text">
              {editing.id ? "Edit Bundle" : "New Bundle"}
            </h2>

            <div className="mt-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-nq-text">Name *</label>
                <input
                  type="text"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="e.g. Mani + Pedi Combo"
                  className="mt-1 w-full rounded-xl border border-nq-border bg-nq-bg-input px-3 py-2 text-sm text-nq-text outline-none focus:ring-2 focus:ring-nq-primary"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-nq-text">Description</label>
                <textarea
                  value={editing.description}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                  rows={2}
                  placeholder="Short description for customers…"
                  className="mt-1 w-full resize-none rounded-xl border border-nq-border bg-nq-bg-input px-3 py-2 text-sm text-nq-text outline-none focus:ring-2 focus:ring-nq-primary"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-nq-text">
                  Services * (select 2+)
                </label>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {services.map((s) => {
                    const checked = editing.service_ids.includes(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => toggleService(s.id)}
                        className={cn(
                          "rounded-xl border px-3 py-2 text-left text-sm",
                          checked
                            ? "border-nq-primary bg-nq-primary/10 font-semibold text-nq-primary"
                            : "border-nq-border text-nq-text hover:border-nq-primary/50",
                        )}
                      >
                        {s.name}
                        {s.duration_minutes ? (
                          <span className="ml-1 text-nq-muted">({s.duration_minutes}m)</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium text-nq-text">Price ($)</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={editing.price_cents}
                    onChange={(e) => setEditing({ ...editing, price_cents: e.target.value })}
                    className="mt-1 w-full rounded-xl border border-nq-border bg-nq-bg-input px-3 py-2 text-sm text-nq-text outline-none focus:ring-2 focus:ring-nq-primary"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-nq-text">Savings ($)</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={editing.discount_cents}
                    onChange={(e) => setEditing({ ...editing, discount_cents: e.target.value })}
                    className="mt-1 w-full rounded-xl border border-nq-border bg-nq-bg-input px-3 py-2 text-sm text-nq-text outline-none focus:ring-2 focus:ring-nq-primary"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-nq-text">Duration (min)</label>
                  <input
                    type="number"
                    min="15"
                    step="5"
                    value={editing.duration_minutes}
                    onChange={(e) => setEditing({ ...editing, duration_minutes: e.target.value })}
                    className="mt-1 w-full rounded-xl border border-nq-border bg-nq-bg-input px-3 py-2 text-sm text-nq-text outline-none focus:ring-2 focus:ring-nq-primary"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm text-nq-text">
                <input
                  type="checkbox"
                  checked={editing.is_active}
                  onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })}
                  className="h-4 w-4 rounded accent-nq-primary"
                />
                Show on booking page (active)
              </label>

              {error ? (
                <p className="text-sm text-red-500">{error}</p>
              ) : null}
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => { setEditing(null); setError(null); }}
                className="rounded-xl border border-nq-border px-4 py-2 text-sm font-medium text-nq-text hover:bg-nq-bg-input"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="rounded-xl bg-nq-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save Bundle"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
