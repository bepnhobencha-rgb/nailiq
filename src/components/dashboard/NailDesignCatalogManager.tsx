"use client";

import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ImagePlus, Sparkles } from "lucide-react";

type MappingStatus = "ai_suggested" | "ready" | "needs_review";
type Design = { id: string; name: string; description: string | null; active: boolean; previewUrl: string | null; serviceIds: string[]; addonServiceIds: string[]; defaultServiceId: string | null; confidence?: number | null; visualConfidence?: number | null; serviceConfidence?: number | null; baseServiceKnown?: boolean; reason?: string; attributes?: string[]; requiredQuestion?: string | null; status?: MappingStatus };
type Option = { id: string; name: string };
type AutoMapResult = Pick<Design, "serviceIds" | "addonServiceIds" | "defaultServiceId" | "confidence" | "visualConfidence" | "serviceConfidence" | "baseServiceKnown" | "reason" | "attributes" | "requiredQuestion" | "status"> & { designId: string; error?: string };

export function NailDesignCatalogManager({ slug, initialDesigns, serviceOptions, addOnOptions }: { slug: string; initialDesigns: Design[]; serviceOptions: Option[]; addOnOptions: Option[] }) {
  const [designs, setDesigns] = useState(initialDesigns);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  async function submit(formData: FormData) {
    setBusy(true); setMessage(null); formData.set("slug", slug);
    try {
      const response = await fetch("/api/dashboard/nail-designs", { method: "POST", body: formData });
      const payload = await response.json() as { design?: Design; error?: string };
      if (!response.ok || !payload.design) throw new Error(payload.error || "upload_failed");
      setDesigns((current) => [...current, payload.design!]);
      formRef.current?.reset();
      setMessage(payload.design.status === "needs_review"
        ? "Design published. AI needs you to review this uncertain match."
        : "Design published and mapped to your salon menu by AI.");
    } catch {
      setMessage("Could not publish this design. Check the image and try again.");
    } finally { setBusy(false); }
  }

  async function saveMapping(design: Design, serviceIds: string[], addonServiceIds: string[], defaultServiceId: string | null) {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/dashboard/nail-designs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, designId: design.id, serviceIds, addonServiceIds, defaultServiceId }),
      });
      if (!response.ok) throw new Error("update_failed");
      setDesigns((current) => current.map((item) => item.id === design.id ? { ...item, serviceIds, addonServiceIds, defaultServiceId, status: "ready" } : item));
      setMessage(`Smart Quote mapping saved for ${design.name}.`);
    } catch {
      setMessage("Could not save the service mapping. Please try again.");
    } finally { setBusy(false); }
  }

  async function autoMapCatalog() {
    setBusy(true); setMessage(null);
    let mapped = 0; let review = 0; let failed = 0;
    try {
      for (let index = 0; index < designs.length; index += 6) {
        const designIds = designs.slice(index, index + 6).map((design) => design.id);
        const response = await fetch("/api/dashboard/nail-designs", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, designIds }),
        });
        const payload = await response.json() as { results?: AutoMapResult[]; error?: string };
        if (!response.ok || !payload.results) throw new Error(payload.error || "auto_map_failed");
        const updates = new Map(payload.results.map((result) => [result.designId, result]));
        setDesigns((current) => current.map((design) => {
          const result = updates.get(design.id);
          return result && !result.error ? { ...design, ...result } : design;
        }));
        for (const result of payload.results) {
          if (result.error) failed += 1;
          else if (result.status === "needs_review") review += 1;
          else mapped += 1;
        }
        setMessage(`AI mapped ${mapped} design${mapped === 1 ? "" : "s"}${review ? ` · ${review} need review` : ""}.`);
      }
      if (failed) setMessage(`AI mapped ${mapped} designs · ${review} need review · ${failed} could not be processed.`);
    } catch {
      setMessage("AI auto-mapping paused. Saved results are safe; try again for the remaining designs.");
    } finally { setBusy(false); }
  }

  return (
    <main className="mx-auto w-full max-w-5xl p-4 sm:p-8">
      <p className="text-sm font-medium text-nq-muted">Settings / Nail Try-On</p>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-3xl font-semibold text-nq-foreground">AI design catalog</h1><p className="mt-2 max-w-2xl text-sm text-nq-muted">NailIQ analyzes each design against your real menu. You only review uncertain matches.</p></div><button type="button" disabled={busy || !designs.length} onClick={() => void autoMapCatalog()} className="flex min-h-11 items-center gap-2 rounded-full bg-nq-primary px-5 font-semibold text-white disabled:opacity-50"><Sparkles className="h-4 w-4" />{busy ? "AI is working…" : "Auto-map catalog"}</button></div>
      <form ref={formRef} action={(data) => void submit(data)} className="mt-8 grid gap-4 rounded-2xl border border-nq-border bg-nq-card p-5 sm:grid-cols-2">
        <label className="text-sm font-medium text-nq-foreground">Design name<input name="name" required maxLength={120} className="mt-2 min-h-11 w-full rounded-xl border border-nq-border bg-nq-surface px-3" /></label>
        <label className="text-sm font-medium text-nq-foreground">Reference image<input name="image" required type="file" accept="image/jpeg,image/png,image/webp" className="mt-2 block w-full text-sm" /></label>
        <label className="text-sm font-medium text-nq-foreground sm:col-span-2">Short description<input name="description" maxLength={240} className="mt-2 min-h-11 w-full rounded-xl border border-nq-border bg-nq-surface px-3" /></label>
        <div className="rounded-xl border border-nq-border bg-nq-surface p-3 text-sm text-nq-muted sm:col-span-2"><Sparkles className="mr-2 inline h-4 w-4 text-nq-primary" />AI will inspect the image, select eligible services and add-ons, choose the default, and flag uncertain matches.</div>
        <button disabled={busy} className="flex min-h-11 items-center justify-center gap-2 rounded-full bg-nq-primary px-5 font-semibold text-white disabled:opacity-60"><ImagePlus className="h-4 w-4" />{busy ? "AI is analyzing…" : "Publish & auto-map"}</button>
        {message ? <p className="self-center text-sm text-nq-muted" role="status">{message}</p> : null}
      </form>
      <section className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {designs.map((design) => <DesignMappingCard key={`${design.id}:${design.serviceIds.join(",")}:${design.addonServiceIds.join(",")}:${design.status || ""}`} design={design} serviceOptions={serviceOptions} addOnOptions={addOnOptions} busy={busy} onSave={saveMapping} />)}
      </section>
    </main>
  );
}

function DesignMappingCard({ design, serviceOptions, addOnOptions, busy, onSave }: { design: Design; serviceOptions: Option[]; addOnOptions: Option[]; busy: boolean; onSave: (design: Design, serviceIds: string[], addonServiceIds: string[], defaultServiceId: string | null) => Promise<void> }) {
  const [serviceIds, setServiceIds] = useState(design.serviceIds);
  const [addonServiceIds, setAddonServiceIds] = useState(design.addonServiceIds);
  const [defaultServiceId, setDefaultServiceId] = useState(design.defaultServiceId || "");
  const toggle = (ids: string[], id: string) => ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
  const changed = JSON.stringify(serviceIds) !== JSON.stringify(design.serviceIds) || JSON.stringify(addonServiceIds) !== JSON.stringify(design.addonServiceIds) || defaultServiceId !== (design.defaultServiceId || "");
  function toggleService(id: string) {
    const next = toggle(serviceIds, id);
    setServiceIds(next);
    if (!next.includes(defaultServiceId)) setDefaultServiceId(next[0] || "");
  }
  const status = design.status || (design.serviceIds.length ? "ready" : "needs_review");
  const badge = status === "ready" ? { label: "Ready", icon: CheckCircle2, className: "text-emerald-700 bg-emerald-50" } : status === "ai_suggested" ? { label: "AI suggested", icon: Sparkles, className: "text-blue-700 bg-blue-50" } : { label: "Needs review", icon: AlertTriangle, className: "text-amber-800 bg-amber-50" };
  const BadgeIcon = badge.icon;
  const bestMatch = serviceOptions.find((option) => option.id === defaultServiceId)?.name;
  const alternativeNames = serviceOptions.filter((option) => serviceIds.includes(option.id) && option.id !== defaultServiceId).map((option) => option.name);
  const addonNames = addOnOptions.filter((option) => addonServiceIds.includes(option.id)).map((option) => option.name);
  return <article className="overflow-hidden rounded-2xl border border-nq-border bg-nq-card">{design.previewUrl ? <img src={design.previewUrl} alt={design.name} className="aspect-square w-full object-cover" /> : <div className="aspect-square bg-nq-surface" />}<div className="space-y-3 p-3"><div className="flex items-start justify-between gap-2"><div><h2 className="font-semibold text-nq-foreground">{design.name}</h2>{design.description ? <p className="mt-1 text-xs text-nq-muted">{design.description}</p> : null}</div><span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ${badge.className}`}><BadgeIcon className="h-3 w-3" />{badge.label}</span></div>{design.attributes?.length ? <div className="flex flex-wrap gap-1">{design.attributes.map((attribute) => <span key={attribute} className="rounded-full bg-nq-surface px-2 py-1 text-[11px] text-nq-muted">{attribute}</span>)}</div> : null}{design.requiredQuestion ? <div className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900"><p className="font-semibold">One detail needed</p><p className="mt-1">{design.requiredQuestion}</p></div> : null}<div className="rounded-xl bg-nq-surface p-3 text-xs"><p><span className="font-semibold">Best match:</span> {bestMatch || "Waiting for customer answer"}</p>{alternativeNames.length ? <p className="mt-1"><span className="font-medium">Alternatives:</span> {alternativeNames.join(", ")}</p> : null}{addonNames.length ? <p className="mt-1"><span className="font-medium">Required add-ons:</span> {addonNames.join(", ")}</p> : null}</div>{design.reason ? <details className="text-xs text-nq-muted"><summary className="cursor-pointer font-medium">Why NailIQ chose this</summary><p className="mt-2">{design.reason}</p><p className="mt-1">Visual {typeof design.visualConfidence === "number" ? `${Math.round(design.visualConfidence * 100)}%` : "—"} · Service {typeof design.serviceConfidence === "number" ? `${Math.round(design.serviceConfidence * 100)}%` : "—"}</p></details> : null}<details className="rounded-xl border border-nq-border p-2"><summary className="cursor-pointer text-xs font-semibold text-nq-foreground">Review or edit</summary><div className="mt-2 space-y-3"><fieldset><legend className="text-xs font-medium text-nq-muted">Services</legend>{serviceOptions.map((option) => <div key={option.id} className="flex items-center gap-2 py-1 text-sm"><input aria-label={`${design.name} ${option.name}`} type="checkbox" checked={serviceIds.includes(option.id)} onChange={() => toggleService(option.id)} /><span className="min-w-0 flex-1 truncate">{option.name}</span>{serviceIds.includes(option.id) ? <label className="flex items-center gap-1 text-[11px]"><input type="radio" name={`${design.id}-default`} checked={defaultServiceId === option.id} onChange={() => setDefaultServiceId(option.id)} />Default</label> : null}</div>)}</fieldset><fieldset><legend className="text-xs font-medium text-nq-muted">Add-ons</legend>{addOnOptions.map((option) => <label key={option.id} className="flex items-center gap-2 py-1 text-sm"><input type="checkbox" checked={addonServiceIds.includes(option.id)} onChange={() => setAddonServiceIds(toggle(addonServiceIds, option.id))} />{option.name}</label>)}</fieldset><button type="button" disabled={busy || !changed} onClick={() => void onSave(design, serviceIds, addonServiceIds, defaultServiceId || null)} className="min-h-10 w-full rounded-full bg-nq-primary px-3 text-sm font-semibold text-white disabled:opacity-40">Confirm mapping</button></div></details></div></article>;
}
