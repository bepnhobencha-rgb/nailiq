import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";

function generateGiftCode(): string {
  const hex = crypto.randomUUID().replace(/-/g, "").toUpperCase();
  return `GFT-${hex.slice(0, 4)}${hex.slice(4, 8)}`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { slug, valueCents, fromName, message, recipientPhone } = body as {
      slug: string;
      valueCents: number;
      fromName?: string;
      message?: string;
      recipientPhone?: string;
    };

    if (!slug || !valueCents || valueCents < 100 || valueCents > 100_000_00) {
      return NextResponse.json({ error: "invalid_value" }, { status: 400 });
    }

    const supabase = createServiceRoleClient();
    const { data: salon } = await supabase
      .from("salons" as never)
      .select("id")
      .eq("slug", slug)
      .is("archived_at", null)
      .maybeSingle();

    if (!salon) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const code = generateGiftCode();
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

    const { data: voucher, error } = await supabase
      .from("vouchers" as never)
      .insert({
        salon_id: (salon as { id: string }).id,
        code,
        kind: "gift",
        amount_off_cents: valueCents,
        gift_card_value_cents: valueCents,
        gift_card_from_name: fromName?.trim() || null,
        gift_card_message: message?.trim() || null,
        gift_card_purchaser_phone: toCanonicalPhone(recipientPhone),
        client_phone: toCanonicalPhone(recipientPhone),
        expires_at: expiresAt,
        max_uses: 1,
        valid_from: new Date().toISOString(),
      })
      .select("id, code")
      .maybeSingle();

    if (error || !voucher) {
      console.error("[gift-card/purchase]", error);
      return NextResponse.json({ error: "server_error" }, { status: 500 });
    }

    return NextResponse.json({ code: (voucher as { code: string }).code });
  } catch (e) {
    console.error("[gift-card/purchase]", e);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
