import { redirect } from "next/navigation";
import { ChooseSalonClient } from "@/components/auth/ChooseSalonClient";
import { formatSalonDisplayName } from "@/shared/lib/salonDisplay";
import {
  dashboardPathForRole,
  normalizeSalonMemberRole,
} from "@/shared/lib/salonMemberRole";
import { createClient } from "@/shared/lib/supabase/server";

export const dynamic = "force-dynamic";

type MembershipCard = {
  salonId: string;
  slug: string;
  name: string;
  role: ReturnType<typeof normalizeSalonMemberRole>;
  href: string;
};

export default async function ChooseSalonPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const { data: memRows, error: memErr } = await supabase
    .from("salon_members")
    .select("salon_id, role, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  if (memErr) {
    console.error("[choose-salon] salon_members", memErr);
    redirect("/login");
  }

  const valid = (memRows ?? []).filter((r) => Boolean(r?.salon_id));
  if (valid.length === 0) {
    redirect("/register/setup");
  }

  const ids = valid.map((r) => r.salon_id);
  const { data: salons, error: salErr } = await supabase
    .from("salons")
    .select("id, slug, name")
    .in("id", ids);

  if (salErr) {
    console.error("[choose-salon] salons", salErr);
    redirect("/login");
  }

  const salonById = new Map(
    (salons ?? [])
      .filter((s): s is { id: string; slug: string; name: string | null } =>
        Boolean(s?.id) && Boolean(s?.slug),
      )
      .map((s) => [String(s.id), s]),
  );

  const cards: MembershipCard[] = valid
    .map((m) => {
      const sal = salonById.get(String(m.salon_id));
      if (!sal) return null;
      const slug = String(sal.slug).trim();
      if (!slug) return null;
      const role = normalizeSalonMemberRole(m.role);
      return {
        salonId: String(sal.id),
        slug,
        name: formatSalonDisplayName({ name: sal.name, slug }),
        role,
        href: dashboardPathForRole(slug, role),
      };
    })
    .filter((c): c is MembershipCard => c !== null);

  if (cards.length === 0) {
    redirect("/register/setup");
  }
  if (cards.length === 1) {
    redirect(cards[0].href);
  }

  return <ChooseSalonClient cards={cards} />;
}
