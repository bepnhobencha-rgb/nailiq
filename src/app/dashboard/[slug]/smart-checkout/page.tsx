import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { SmartCheckoutPreview } from "@/components/dashboard/SmartCheckoutPreview";
import { SetupBackNav } from "@/components/dashboard/SetupBackNav";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isReleaseFeatureEnabled } from "@/shared/features/featureRegistry";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Smart Checkout · ${slug}` };
}

export default async function SmartCheckoutPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");
  if (!isOwnerOrAdmin(ctx.role)) {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }

  const admin = createServiceRoleClient();
  const [salonResult, squareResult] = await Promise.all([
    admin
      .from("salons" as never)
      .select(
        "name, feature_flags, payment_provider, stripe_connect_account_id, stripe_connect_charges_enabled, stripe_connect_details_submitted",
      )
      .eq("id", ctx.salon.id)
      .maybeSingle(),
    admin
      .from("square_integrations" as never)
      .select("merchant_id, location_id, environment")
      .eq("salon_id", ctx.salon.id)
      .maybeSingle(),
  ]);

  const salon = salonResult.data as {
    name?: string | null;
    feature_flags?: Record<string, unknown> | null;
    payment_provider?: "square" | "stripe" | null;
    stripe_connect_account_id?: string | null;
    stripe_connect_charges_enabled?: boolean | null;
    stripe_connect_details_submitted?: boolean | null;
  } | null;
  const square = squareResult.data as {
    merchant_id?: string | null;
    location_id?: string | null;
    environment?: string | null;
  } | null;

  const configuredProvider = salon?.payment_provider ?? null;
  const providerConnected =
    configuredProvider === "stripe"
      ? Boolean(
          salon?.stripe_connect_account_id &&
            salon.stripe_connect_charges_enabled &&
            salon.stripe_connect_details_submitted,
        )
      : configuredProvider === "square"
        ? Boolean(square?.merchant_id && square?.location_id && square?.environment)
        : false;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-10 sm:px-6">
      <SetupBackNav
        slug={slug}
        title="Smart Checkout Lab"
        backHref={`/dashboard/${encodeURIComponent(slug)}/settings?section=integrations`}
        backLabel="← Integrations"
      />
      <SmartCheckoutPreview
        salonName={(salon?.name ?? "").trim() || ctx.salon.name || slug}
        configuredProvider={configuredProvider}
        providerConnected={providerConnected}
        smartCheckoutEnabled={isReleaseFeatureEnabled(
          { feature_flags: salon?.feature_flags },
          "smart_checkout",
        )}
      />
    </main>
  );
}
