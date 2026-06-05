import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MobileStack } from "@/components/layout/MobileStack";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { SetupBackNav } from "@/components/dashboard/SetupBackNav";
import { ServicesSetupPanel } from "@/components/dashboard/ServicesSetupPanel";
import { loadServiceCategories } from "@/shared/booking/loadServiceCategories";
import { parseServiceCategory } from "@/shared/booking/serviceCategory";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { getUserMessages } from "@/shared/i18n/user";
import { resolveUserLanguage } from "@/shared/i18n/user/resolveUserLanguage";
import { parseCurrency } from "@/shared/lib/currencyFormat";
import { getEffectivePlanLimits } from "@/shared/lib/subscriptionPlans";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Setup · Services · ${slug}`,
    description: "Manage your salon service menu.",
  };
}

export default async function SetupServicesPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    redirect("/register");
  }
  // Salon config is management-only (owner/admin). Front-desk roles
  // (senior/receptionist/nail_tech) run operations but don't edit setup.
  if (ctx.role !== "owner" && ctx.role !== "admin") {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }

  const { data: rows, error } = await ctx.supabase
    .from("services")
    // `category`, `description`, `is_popular`, `is_featured` were added
    // by migrations 20260511500000 + 20260511600000; `price_type` and
    // `price_max_cents` by the variable-pricing migration. Some columns
    // are not yet in the auto-generated DB types so the SELECT is cast.
    .select(
      "id, name, price_cents, price_type, price_max_cents, duration_minutes, buffer_minutes, category, description, is_popular, is_featured" as never,
    )
    .eq("salon_id", ctx.salon.id)
    .is("deleted_at" as never, null)
    .order("name", { ascending: true });

  if (error) {
    console.error("[setup/services]", error);
    redirect("/register");
  }

  // Read the salon's effective plan to size the proactive at-limit
  // banner + hard-disable the Add button on the client. Server still
  // enforces independently via canAddService — this is UX only.
  const { data: planRow } = await ctx.supabase
    .from("salons")
    .select(
      "subscription_plan, plan_override, feature_flags, currency_code" as never,
    )
    .eq("id", ctx.salon.id)
    .maybeSingle();
  const planForLimits = (planRow ?? {}) as {
    subscription_plan?: string | null;
    plan_override?: string | null;
    feature_flags?: Record<string, unknown> | null;
    currency_code?: unknown;
  };
  const planLimits = getEffectivePlanLimits(planForLimits);
  const maxServices = Number.isFinite(planLimits.maxServices)
    ? planLimits.maxServices
    : Number.POSITIVE_INFINITY;
  const currency = parseCurrency(planForLimits.currency_code);
  const categories = await loadServiceCategories();
  const language = await resolveUserLanguage();
  const t = getUserMessages(language);

  return (
    <ResponsiveShell>
      <MobileStack className="min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-4 sm:pt-6">
        <SetupBackNav slug={slug} title={t.setupLabels.servicesTitle} />
        <ServicesSetupPanel
          slug={slug}
          maxServices={maxServices}
          currency={currency}
          categories={categories}
          initialRows={(rows ?? []).map((r) => {
            const row = r as unknown as {
              id: string;
              name?: string;
              price_cents?: number;
              price_type?: unknown;
              price_max_cents?: unknown;
              duration_minutes?: number;
              buffer_minutes?: number;
              category?: unknown;
              description?: unknown;
              is_popular?: unknown;
              is_featured?: unknown;
            };
            const descRaw = row.description;
            const priceMaxRaw = row.price_max_cents;
            return {
              id: String(row.id),
              name: String(row.name ?? ""),
              price_cents: Number(row.price_cents ?? 0),
              // Legacy rows (pre variable-pricing) → default to "fixed".
              price_type:
                typeof row.price_type === "string" &&
                row.price_type.trim().length > 0
                  ? row.price_type.trim()
                  : "fixed",
              price_max_cents:
                priceMaxRaw != null && Number.isFinite(Number(priceMaxRaw))
                  ? Math.round(Number(priceMaxRaw))
                  : null,
              duration_minutes: Number(row.duration_minutes ?? 0),
              buffer_minutes: Number(row.buffer_minutes ?? 0),
              category: parseServiceCategory(row.category),
              description:
                typeof descRaw === "string" && descRaw.trim().length > 0
                  ? descRaw.trim()
                  : null,
              is_popular: row.is_popular === true,
              is_featured: row.is_featured === true,
            };
          })}
        />
      </MobileStack>
    </ResponsiveShell>
  );
}
