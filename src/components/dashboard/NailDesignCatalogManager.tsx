"use client";

import { useRef, useState } from "react";
import { ImagePlus } from "lucide-react";

type Design = { id: string; name: string; description: string | null; active: boolean; previewUrl: string | null; serviceId: string | null; addonServiceId: string | null };
type Option = { id: string; name: string };

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
      setMessage("Design published to the Try-On catalog.");
    } catch {
      setMessage("Could not publish this design. Check the image and try again.");
    } finally { setBusy(false); }
  }

  async function saveMapping(design: Design, serviceId: string, addonServiceId: string) {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/dashboard/nail-designs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, designId: design.id, serviceId: serviceId || null, addonServiceId: addonServiceId || null }),
      });
      if (!response.ok) throw new Error("update_failed");
      setDesigns((current) => current.map((item) => item.id === design.id ? { ...item, serviceId: serviceId || null, addonServiceId: addonServiceId || null } : item));
      setMessage(`Smart Quote mapping saved for ${design.name}.`);
    } catch {
      setMessage("Could not save the service mapping. Please try again.");
    } finally { setBusy(false); }
  }

  return (
    <main className="mx-auto w-full max-w-5xl p-4 sm:p-8">
      <p className="text-sm font-medium text-nq-muted">Settings / Nail Try-On</p>
      <h1 className="mt-2 text-3xl font-semibold text-nq-foreground">Try-On design catalog</h1>
      <p className="mt-2 max-w-2xl text-sm text-nq-muted">Upload only designs your salon can actually perform. Customer hand photos never appear here.</p>
      <form ref={formRef} action={(data) => void submit(data)} className="mt-8 grid gap-4 rounded-2xl border border-nq-border bg-nq-card p-5 sm:grid-cols-2">
        <label className="text-sm font-medium text-nq-foreground">Design name<input name="name" required maxLength={120} className="mt-2 min-h-11 w-full rounded-xl border border-nq-border bg-nq-surface px-3" /></label>
        <label className="text-sm font-medium text-nq-foreground">Reference image<input name="image" required type="file" accept="image/jpeg,image/png,image/webp" className="mt-2 block w-full text-sm" /></label>
        <label className="text-sm font-medium text-nq-foreground sm:col-span-2">Short description<input name="description" maxLength={240} className="mt-2 min-h-11 w-full rounded-xl border border-nq-border bg-nq-surface px-3" /></label>
        <label className="text-sm font-medium text-nq-foreground">Recommended service<select name="serviceId" className="mt-2 min-h-11 w-full rounded-xl border border-nq-border bg-nq-surface px-3"><option value="">Choose later</option>{serviceOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
        <label className="text-sm font-medium text-nq-foreground">Recommended add-on<select name="addonServiceId" className="mt-2 min-h-11 w-full rounded-xl border border-nq-border bg-nq-surface px-3"><option value="">No add-on</option>{addOnOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
        <button disabled={busy} className="flex min-h-11 items-center justify-center gap-2 rounded-full bg-nq-primary px-5 font-semibold text-white disabled:opacity-60"><ImagePlus className="h-4 w-4" />{busy ? "Publishing…" : "Publish design"}</button>
        {message ? <p className="self-center text-sm text-nq-muted" role="status">{message}</p> : null}
      </form>
      <section className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {designs.map((design) => <DesignMappingCard key={design.id} design={design} serviceOptions={serviceOptions} addOnOptions={addOnOptions} busy={busy} onSave={saveMapping} />)}
      </section>
    </main>
  );
}

function DesignMappingCard({ design, serviceOptions, addOnOptions, busy, onSave }: { design: Design; serviceOptions: Option[]; addOnOptions: Option[]; busy: boolean; onSave: (design: Design, serviceId: string, addonServiceId: string) => Promise<void> }) {
  const [serviceId, setServiceId] = useState(design.serviceId || "");
  const [addonServiceId, setAddonServiceId] = useState(design.addonServiceId || "");
  const changed = serviceId !== (design.serviceId || "") || addonServiceId !== (design.addonServiceId || "");
  return <article className="overflow-hidden rounded-2xl border border-nq-border bg-nq-card">{design.previewUrl ? <img src={design.previewUrl} alt={design.name} className="aspect-square w-full object-cover" /> : <div className="aspect-square bg-nq-surface" />}<div className="space-y-3 p-3"><div><h2 className="font-semibold text-nq-foreground">{design.name}</h2>{design.description ? <p className="mt-1 text-xs text-nq-muted">{design.description}</p> : null}</div><label className="block text-xs font-medium text-nq-muted">Service<select aria-label={`${design.name} service`} value={serviceId} onChange={(event) => setServiceId(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-nq-border bg-nq-surface px-2 text-sm text-nq-foreground"><option value="">Not mapped</option>{serviceOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label><label className="block text-xs font-medium text-nq-muted">Add-on<select aria-label={`${design.name} add-on`} value={addonServiceId} onChange={(event) => setAddonServiceId(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-nq-border bg-nq-surface px-2 text-sm text-nq-foreground"><option value="">No add-on</option>{addOnOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label><button type="button" disabled={busy || !changed} onClick={() => void onSave(design, serviceId, addonServiceId)} className="min-h-10 w-full rounded-full bg-nq-primary px-3 text-sm font-semibold text-white disabled:opacity-40">Save Smart Quote</button></div></article>;
}
