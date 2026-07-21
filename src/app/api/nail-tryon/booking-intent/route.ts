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

  return NextResponse.json(
    {
      designName: design.name,
      serviceId: design.service_id,
      addonServiceId: design.addon_service_id,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
