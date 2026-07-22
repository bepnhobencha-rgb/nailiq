import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { TRYON_COOKIE } from "@/shared/nailTryOn/server";
import { verifySessionCredential } from "@/shared/nailTryOn/sessionCredential";

const querySchema = z.object({ sessionId: z.string().uuid() });

type SessionRow = {
  id: string;
  salon_id: string;
  design_id: string | null;
  anonymous_token_hash: string;
  status: string;
};

type DesignRow = {
  id: string;
  name: string;
  service_id: string | null;
  addon_service_id: string | null;
};

type MappingRow = {
  service_id: string;
  mapping_type: "service" | "addon";
  is_default: boolean;
};

export async function GET(request: Request) {
  const parsed = querySchema.safeParse({
    sessionId: new URL(request.url).searchParams.get("sessionId"),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const db = createServiceRoleClient();
  const { data: rawSession } = await db
    .from("nail_tryon_sessions" as never)
    .select("id, salon_id, design_id, anonymous_token_hash, status")
    .eq("id", parsed.data.sessionId)
    .maybeSingle();
  const session = rawSession as unknown as SessionRow | null;
  const credential = (await cookies()).get(TRYON_COOKIE)?.value;

  if (
    !session ||
    !verifySessionCredential(credential, session.id, session.anonymous_token_hash)
  ) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (
    !session.design_id ||
    (session.status !== "ready" && session.status !== "attached")
  ) {
    return NextResponse.json({ error: "invalid_state" }, { status: 409 });
  }

  const { data: rawDesign } = await db
    .from("nail_designs" as never)
    .select("id, name, service_id, addon_service_id")
    .eq("id", session.design_id)
    .eq("salon_id", session.salon_id)
    .eq("is_active", true)
    .is("deleted_at", null)
    .maybeSingle();
  const design = rawDesign as unknown as DesignRow | null;
  if (!design) {
    return NextResponse.json({ error: "design_not_found" }, { status: 404 });
  }

  const { data: rawMappings } = await db
    .from("nail_design_service_mappings" as never)
    .select("service_id, mapping_type, is_default")
    .eq("design_id", design.id)
    .eq("salon_id", session.salon_id)
    .order("sort_order");
  const mappings = (rawMappings || []) as unknown as MappingRow[];
  const serviceMappings = mappings.filter((mapping) => mapping.mapping_type === "service");
  const addonMappings = mappings.filter((mapping) => mapping.mapping_type === "addon");
  const serviceIds = serviceMappings.map((mapping) => mapping.service_id);
  const addonServiceIds = addonMappings.map((mapping) => mapping.service_id);
  const defaultServiceId =
    serviceMappings.find((mapping) => mapping.is_default)?.service_id ||
    design.service_id ||
    serviceIds[0] ||
    null;

  return NextResponse.json(
    {
      designName: design.name,
      serviceId: defaultServiceId,
      addonServiceId: addonServiceIds[0] || design.addon_service_id,
      serviceIds: serviceIds.length ? serviceIds : design.service_id ? [design.service_id] : [],
      addonServiceIds: addonServiceIds.length ? addonServiceIds : design.addon_service_id ? [design.addon_service_id] : [],
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
