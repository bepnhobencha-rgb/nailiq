import { notFound } from "next/navigation";
import { NailDesignCatalogManager } from "@/components/dashboard/NailDesignCatalogManager";
import { requireReleaseFeatureEnabled } from "@/shared/features/requireReleaseFeature";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

type Props = { params: Promise<{ slug: string }> };
type DesignRow = { id: string; name: string; description: string | null; preview_path: string; is_active: boolean; service_id: string | null; addon_service_id: string | null };
type ServiceRow = { id: string; name: string; is_addon: boolean };

export default async function NailTryOnSetupPage({ params }: Props) {
  const { slug } = await params;
  const gate = await requireReleaseFeatureEnabled(slug, "nail_tryon");
  if (!gate.ok) notFound();
  const db = createServiceRoleClient();
  const [{ data }, { data: serviceRows }] = await Promise.all([
    db.from("nail_designs" as never)
      .select("id, name, description, preview_path, is_active, service_id, addon_service_id")
      .eq("salon_id", gate.salon.id).is("deleted_at", null).order("sort_order"),
    db.from("services" as never)
      .select("id, name, is_addon")
      .eq("salon_id", gate.salon.id).is("deleted_at", null).order("name"),
  ]);
  const designs = await Promise.all(((data || []) as unknown as DesignRow[]).map(async (row) => {
    const { data: signed } = await db.storage.from("nail-tryon").createSignedUrl(row.preview_path, 300);
    return { id: row.id, name: row.name, description: row.description, active: row.is_active, previewUrl: signed?.signedUrl || null, serviceId: row.service_id, addonServiceId: row.addon_service_id };
  }));
  const serviceOptions = ((serviceRows || []) as unknown as ServiceRow[]).filter((row) => !row.is_addon).map(({ id, name }) => ({ id, name }));
  const addOnOptions = ((serviceRows || []) as unknown as ServiceRow[]).filter((row) => row.is_addon).map(({ id, name }) => ({ id, name }));
  return <NailDesignCatalogManager slug={slug} initialDesigns={designs} serviceOptions={serviceOptions} addOnOptions={addOnOptions} />;
}
