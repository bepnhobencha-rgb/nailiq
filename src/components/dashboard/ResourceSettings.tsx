"use client";

import { useEffect, useState, useTransition } from "react";
import {
  listResourceSettings,
  createResource,
  updateResource,
  deleteResource,
  saveParallelServicePolicy,
  deleteParallelServicePolicy,
  setResourcesMode,
  applyResourcePreset,
  type ResourceRow,
  type ParallelServiceOption,
  type ParallelServicePolicyRow,
} from "@/shared/dashboard/resourceActions";
import { resolveVertical } from "@/shared/verticals/registry";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Props = {
  slug: string;
  initialEnabled: boolean;
  initialAxis: "staff" | "resource";
  vertical: string;
};

/**
 * Owner settings for the optional resource layer (beds/chairs/stations). Toggle
 * the layer on/off, pick the timeline axis, and manage the resource list. Labels
 * adapt to the salon vertical ("Bed" for head spa, "Station" for nail).
 */
export function ResourceSettings({ slug, initialEnabled, initialAxis, vertical }: Props) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const preset = resolveVertical(vertical).resourceDefaults;
  const unit = preset ? (vi ? preset.label.vi : preset.label.en) : vi ? "Chỗ làm" : "Resource";

  const [enabled, setEnabled] = useState(initialEnabled);
  const [axis, setAxis] = useState<"staff" | "resource">(initialAxis);
  const [rows, setRows] = useState<ResourceRow[]>([]);
  const [services, setServices] = useState<ParallelServiceOption[]>([]);
  const [policies, setPolicies] = useState<ParallelServicePolicyRow[]>([]);
  const [serviceAId, setServiceAId] = useState("");
  const [serviceBId, setServiceBId] = useState("");
  const [resourceMode, setResourceMode] = useState<"shared" | "distinct" | "either">("shared");
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await listResourceSettings(slug);
      if (alive && r.ok) {
        setRows(r.resources);
        setServices(r.services);
        setPolicies(r.policies);
      }
      if (alive && !r.ok) setError(r.error);
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [slug]);

  function saveMode(nextEnabled: boolean, nextAxis: "staff" | "resource") {
    const prevEnabled = enabled;
    const prevAxis = axis;
    setEnabled(nextEnabled);
    setAxis(nextAxis);
    setError(null);
    startTransition(async () => {
      const r = await setResourcesMode(slug, { enabled: nextEnabled, axis: nextAxis });
      if (!r.ok) {
        setEnabled(prevEnabled);
        setAxis(prevAxis);
        setError(r.error);
      }
    });
  }

  function add() {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    startTransition(async () => {
      const r = await createResource(slug, { name, kind: preset?.kind });
      if (r.ok) {
        setRows((prev) => [...prev, {
          id: r.id,
          name,
          kind: preset?.kind ?? "station",
          display_order: prev.length,
          status: "active",
          same_guest_parallel_capacity: 1,
        }]);
        setNewName("");
      } else setError(r.error);
    });
  }

  function commitRename(id: string, name: string) {
    startTransition(async () => {
      await updateResource(slug, { id, name });
    });
  }

  function toggleActive(id: string, status: string) {
    const next = status === "active" ? "inactive" : "active";
    setRows((prev) => prev.map((x) => (x.id === id ? { ...x, status: next } : x)));
    startTransition(async () => {
      await updateResource(slug, { id, status: next });
    });
  }

  function setParallelCapacity(id: string, capacity: 1 | 2) {
    const previous = rows.find((row) => row.id === id)?.same_guest_parallel_capacity ?? 1;
    setRows((current) => current.map((row) =>
      row.id === id ? { ...row, same_guest_parallel_capacity: capacity } : row
    ));
    setError(null);
    startTransition(async () => {
      const result = await updateResource(slug, {
        id,
        sameGuestParallelCapacity: capacity,
      });
      if (!result.ok) {
        setRows((current) => current.map((row) =>
          row.id === id ? { ...row, same_guest_parallel_capacity: previous } : row
        ));
        setError(result.error);
      }
    });
  }

  function saveParallelPolicy() {
    if (!serviceAId || !serviceBId || serviceAId === serviceBId) return;
    setError(null);
    startTransition(async () => {
      const result = await saveParallelServicePolicy(slug, {
        serviceAId,
        serviceBId,
        resourceMode,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPolicies((current) => [
        ...current.filter((policy) => policy.id !== result.policy.id && !(
          policy.service_a_id === result.policy.service_a_id &&
          policy.service_b_id === result.policy.service_b_id
        )),
        result.policy,
      ]);
      setServiceAId("");
      setServiceBId("");
    });
  }

  function removeParallelPolicy(id: string) {
    const previous = policies;
    setPolicies((current) => current.filter((policy) => policy.id !== id));
    setError(null);
    startTransition(async () => {
      const result = await deleteParallelServicePolicy(slug, id);
      if (!result.ok) {
        setPolicies(previous);
        setError(result.error);
      }
    });
  }

  function remove(id: string) {
    setRows((prev) => prev.filter((x) => x.id !== id));
    startTransition(async () => {
      await deleteResource(slug, id);
    });
  }

  function runPreset() {
    setError(null);
    startTransition(async () => {
      const r = await applyResourcePreset(slug);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      const fresh = await listResourceSettings(slug);
      if (fresh.ok) {
        setRows(fresh.resources);
        setServices(fresh.services);
        setPolicies(fresh.policies);
      }
      setEnabled(true);
      if (preset) setAxis(preset.gridAxis);
    });
  }

  return (
    <section
      data-testid="settings-resources"
      className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
    >
      {/* Header + master toggle */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-nq-foreground">
            {vi ? `Quản lý ${unit.toLowerCase()} (giường/ghế/bàn)` : "Manage resources (beds/chairs/stations)"}
          </p>
          <p className="mt-0.5 text-xs text-nq-muted">
            {vi
              ? "Bật khi thợ luân chuyển chỗ, hoặc chỗ dùng chung có hạn (ghế pedi, giường). Tắt → lịch theo thợ như cũ."
              : "Enable when staff rotate between spots, or shared spots are limited (pedi chairs, beds). Off → staff-only timeline as before."}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={pending}
          data-testid="resources-enabled-toggle"
          onClick={() => saveMode(!enabled, axis)}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${enabled ? "bg-nq-primary" : "bg-white/15"}`}
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${enabled ? "translate-x-5" : "translate-x-0.5"}`} />
        </button>
      </div>

      {enabled ? (
        <div className="mt-4 space-y-4">
          {/* Grid axis */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
              {vi ? "Lịch hiển thị theo" : "Timeline columns by"}
            </p>
            <div className="mt-1.5 flex gap-2">
              {(["staff", "resource"] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  disabled={pending}
                  onClick={() => saveMode(enabled, a)}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${axis === a ? "border-nq-primary bg-nq-primary/15 text-nq-foreground" : "border-nq-border/30 text-nq-muted"}`}
                >
                  {a === "staff" ? (vi ? "Thợ" : "Staff") : vi ? unit : unit}
                </button>
              ))}
            </div>
          </div>

          {/* Resource list */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
              {vi ? `Danh sách ${unit.toLowerCase()}` : `${unit} list`}
            </p>

            {loading ? (
              <p className="mt-2 text-sm text-nq-muted">{vi ? "Đang tải…" : "Loading…"}</p>
            ) : rows.length === 0 ? (
              <div className="mt-2">
                <p className="text-sm text-nq-muted">{vi ? "Chưa có chỗ nào." : "No resources yet."}</p>
                {preset ? (
                  <button
                    type="button"
                    disabled={pending}
                    data-testid="resources-apply-preset"
                    onClick={runPreset}
                    className="mt-2 rounded-lg border border-nq-primary/50 bg-nq-primary/10 px-3 py-1.5 text-sm font-medium text-nq-foreground disabled:opacity-50"
                  >
                    {vi
                      ? `Thiết lập nhanh ${preset.seedNames.length} ${unit.toLowerCase()} mẫu`
                      : `Quick-add ${preset.seedNames.length} sample ${unit.toLowerCase()}s`}
                  </button>
                ) : null}
              </div>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {rows.map((r) => (
                  <li key={r.id} className="grid gap-2 rounded-xl border border-nq-border/20 p-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center">
                    <input
                      defaultValue={r.name}
                      disabled={pending}
                      onBlur={(e) => {
                        const v = e.currentTarget.value.trim();
                        if (v && v !== r.name) commitRename(r.id, v);
                      }}
                      className={`min-w-0 flex-1 rounded-lg border border-nq-border/30 bg-nq-surface px-2.5 py-1.5 text-sm text-nq-foreground ${r.status === "inactive" ? "opacity-50 line-through" : ""}`}
                    />
                    <label className="flex items-center gap-2 text-xs text-nq-muted">
                      <span>{vi ? "Cùng khách" : "Same guest"}</span>
                      <select
                        aria-label={vi ? `Số dịch vụ cùng lúc trên ${r.name}` : `Parallel services on ${r.name}`}
                        value={r.same_guest_parallel_capacity}
                        disabled={pending || r.status !== "active"}
                        onChange={(event) => setParallelCapacity(
                          r.id,
                          event.target.value === "2" ? 2 : 1,
                        )}
                        className="rounded-lg border border-nq-border/30 bg-nq-surface px-2 py-1.5 text-xs text-nq-foreground disabled:opacity-50"
                      >
                        <option value={1}>{vi ? "1 dịch vụ" : "1 service"}</option>
                        <option value={2}>{vi ? "2 cùng lúc" : "2 at once"}</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => toggleActive(r.id, r.status)}
                      title={vi ? "Tạm ngưng / Kích hoạt" : "Toggle active"}
                      className="rounded-lg border border-nq-border/30 px-2 py-1 text-xs text-nq-muted disabled:opacity-50"
                    >
                      {r.status === "active" ? (vi ? "Ngưng" : "Off") : vi ? "Bật" : "On"}
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => remove(r.id)}
                      title={vi ? "Xoá" : "Delete"}
                      className="rounded-lg border border-nq-error/40 px-2 py-1 text-xs text-nq-error disabled:opacity-50"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* Add new */}
            <div className="mt-2 flex gap-2">
              <input
                value={newName}
                disabled={pending}
                placeholder={vi ? `Tên ${unit.toLowerCase()} mới…` : `New ${unit.toLowerCase()} name…`}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") add();
                }}
                className="min-w-0 flex-1 rounded-lg border border-nq-border/30 bg-nq-surface px-2.5 py-1.5 text-sm text-nq-foreground"
              />
              <button
                type="button"
                disabled={pending || !newName.trim()}
                onClick={add}
                className="rounded-lg border border-nq-primary/50 bg-nq-primary/10 px-3 py-1.5 text-sm font-medium text-nq-foreground disabled:opacity-50"
              >
                {vi ? "Thêm" : "Add"}
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-nq-border/25 bg-nq-surface/50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
              {vi ? "Cặp dịch vụ được làm cùng lúc" : "Services allowed in parallel"}
            </p>
            <p className="mt-1 text-xs text-nq-muted">
              {vi
                ? "Không có trong danh sách = luôn làm nối tiếp. Dùng chung chỉ hoạt động trên ghế/giường đã chọn “2 cùng lúc”."
                : "Missing pairs always stay sequential. Shared mode only works on a chair/bed set to “2 at once”."}
            </p>

            {policies.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {policies.map((policy) => {
                  const first = services.find((service) => service.id === policy.service_a_id)?.name ?? policy.service_a_id;
                  const second = services.find((service) => service.id === policy.service_b_id)?.name ?? policy.service_b_id;
                  const modeLabel = policy.resource_mode === "shared"
                    ? (vi ? "chung một ghế/giường" : "one shared resource")
                    : policy.resource_mode === "distinct"
                      ? (vi ? "hai chỗ riêng" : "two distinct resources")
                      : (vi ? "NailIQ tự chọn" : "NailIQ chooses");
                  return (
                    <li key={policy.id} className="flex items-center justify-between gap-3 rounded-lg border border-nq-border/20 px-3 py-2 text-sm">
                      <span className="min-w-0 text-nq-foreground">
                        <span className="font-medium">{first} + {second}</span>
                        <span className="block text-xs text-nq-muted">{modeLabel}</span>
                      </span>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => removeParallelPolicy(policy.id)}
                        className="rounded-lg border border-nq-error/40 px-2 py-1 text-xs text-nq-error disabled:opacity-50"
                      >
                        {vi ? "Xoá" : "Remove"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}

            {services.length >= 2 ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <select
                  aria-label={vi ? "Dịch vụ thứ nhất" : "First service"}
                  value={serviceAId}
                  disabled={pending}
                  onChange={(event) => setServiceAId(event.target.value)}
                  className="rounded-lg border border-nq-border/30 bg-nq-surface px-2.5 py-2 text-sm text-nq-foreground"
                >
                  <option value="">{vi ? "Dịch vụ 1" : "Service 1"}</option>
                  {services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
                </select>
                <select
                  aria-label={vi ? "Dịch vụ thứ hai" : "Second service"}
                  value={serviceBId}
                  disabled={pending}
                  onChange={(event) => setServiceBId(event.target.value)}
                  className="rounded-lg border border-nq-border/30 bg-nq-surface px-2.5 py-2 text-sm text-nq-foreground"
                >
                  <option value="">{vi ? "Dịch vụ 2" : "Service 2"}</option>
                  {services.filter((service) => service.id !== serviceAId).map((service) => (
                    <option key={service.id} value={service.id}>{service.name}</option>
                  ))}
                </select>
                <select
                  aria-label={vi ? "Cách dùng ghế hoặc giường" : "Resource arrangement"}
                  value={resourceMode}
                  disabled={pending}
                  onChange={(event) => setResourceMode(
                    event.target.value === "distinct" || event.target.value === "either"
                      ? event.target.value
                      : "shared",
                  )}
                  className="rounded-lg border border-nq-border/30 bg-nq-surface px-2.5 py-2 text-sm text-nq-foreground"
                >
                  <option value="shared">{vi ? "Chung một ghế/giường" : "One shared resource"}</option>
                  <option value="distinct">{vi ? "Hai chỗ riêng" : "Two distinct resources"}</option>
                  <option value="either">{vi ? "NailIQ tự chọn" : "NailIQ chooses"}</option>
                </select>
                <button
                  type="button"
                  disabled={pending || !serviceAId || !serviceBId || serviceAId === serviceBId}
                  onClick={saveParallelPolicy}
                  className="rounded-lg border border-nq-primary/50 bg-nq-primary/10 px-3 py-2 text-sm font-medium text-nq-foreground disabled:opacity-50 sm:col-span-3"
                >
                  {vi ? "Cho phép cặp này làm cùng lúc" : "Allow this pair in parallel"}
                </button>
              </div>
            ) : (
              <p className="mt-3 text-xs text-nq-muted">
                {vi ? "Cần ít nhất 2 dịch vụ chính để cấu hình." : "Add at least two main services to configure this."}
              </p>
            )}
          </div>
        </div>
      ) : null}

      {error ? <p className="mt-2 text-xs font-semibold text-nq-error">{error}</p> : null}
    </section>
  );
}
