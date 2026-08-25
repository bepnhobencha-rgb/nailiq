import { notFound, redirect } from "next/navigation";
import { NailDesignCatalogManager } from "@/components/dashboard/NailDesignCatalogManager";
import { requireReleaseFeatureEnabled } from "@/shared/features/requireReleaseFeature";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { isNailTryOnEligibleSalon } from "@/shared/nailTryOn/eligibility";

type Props = { params: Promise<{ slug: string }> };
type DesignRow = { id: string; name: string; description: string | null; preview_path: string; is_active: boolean; service_id: string | null };
type ServiceRow = { id: string; name: string; is_addon: boolean };
type MappingRow = { design_id: string; service_id: string; mapping_type: "service" | "addon"; is_default: boolean; sort_order: number };

export default async function NailTryOnSetupPage({ params }: Props) {
  const { slug } = await params;
  // This is a catalog-management surface. Resolve the actor from the request
  // and reject lower salon roles before the release-feature helper or any
  // service-role read can expose designs, service mappings, or signed images.
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");
  if (!isOwnerOrAdmin(ctx.role)) {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }
  const gate = await requireReleaseFeatureEnabled(slug, "nail_tryon");
  if (!gate.ok || !isNailTryOnEligibleSalon(gate.salon)) notFound();
  const db = createServiceRoleClient();
  const [{ data }, { data: serviceRows }, { data: mappingRows }] = await Promise.all([
    db.from("nail_designs" as never)
      .select("id, name, description, preview_path, is_active, service_id")
      .eq("salon_id", gate.salon.id).is("deleted_at", null).order("sort_order"),
    db.from("services" as never)
      .select("id, name, is_addon")
      .eq("salon_id", gate.salon.id).is("deleted_at", null).order("name"),
    db.from("nail_design_service_mappings" as never)
      .select("design_id, service_id, mapping_type, is_default, sort_order")
      .eq("salon_id", gate.salon.id).order("sort_order"),
  ]);
  const mappings = (mappingRows || []) as unknown as MappingRow[];
  const designs = await Promise.all(((data || []) as unknown as DesignRow[]).map(async (row) => {
    const { data: signed } = await db.storage.from("nail-tryon").createSignedUrl(row.preview_path, 300);
    const selected = mappings.filter((mapping) => mapping.design_id === row.id);
    const services = selected.filter((mapping) => mapping.mapping_type === "service");
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      active: row.is_active,
      previewUrl: signed?.signedUrl || null,
      serviceIds: services.map((mapping) => mapping.service_id),
      addonServiceIds: selected.filter((mapping) => mapping.mapping_type === "addon").map((mapping) => mapping.service_id),
      defaultServiceId: services.find((mapping) => mapping.is_default)?.service_id || row.service_id,
    };
  }));
  const serviceOptions = ((serviceRows || []) as unknown as ServiceRow[]).filter((row) => !row.is_addon).map(({ id, name }) => ({ id, name }));
  const addOnOptions = ((serviceRows || []) as unknown as ServiceRow[]).filter((row) => row.is_addon).map(({ id, name }) => ({ id, name }));
  return <NailDesignCatalogManager slug={slug} initialDesigns={designs} serviceOptions={serviceOptions} addOnOptions={addOnOptions} />;
}
