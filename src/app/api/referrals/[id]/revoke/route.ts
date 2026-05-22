import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { createClient } from "@/shared/lib/supabase/server";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/referrals/:id/revoke
 * Revokes a referral for abuse prevention. Owner-only.
 */
export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const serverClient = await createClient();
  const { data: { user } } = await serverClient.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const db = createServiceRoleClient();

  // Fetch referral to verify salon ownership
  const { data: referral } = await db
    .from("referrals")
    .select("id, salon_id")
    .eq("id", id)
    .single();

  if (!referral) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const { data: membership } = await serverClient
    .from("salon_members")
    .select("role")
    .eq("salon_id", referral.salon_id)
    .eq("user_id", user.id)
    .single();

  if (!membership || membership.role !== "owner") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  await db
    .from("referrals")
    .update({ status: "revoked", updated_at: new Date().toISOString() })
    .eq("id", id);

  return NextResponse.json({ ok: true });
}
