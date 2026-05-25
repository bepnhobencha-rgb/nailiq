"use client";

import { useState, useTransition } from "react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import {
  createCheckoutSession,
  createCustomerPortalSession,
} from "@/shared/dashboard/stripeActions";
import type { ReceptionistMessages } from "@/shared/i18n/user";
import { cn } from "@/shared/lib/cn";
import {
  PLAN_LIMITS,
  type SubscriptionPlan,
} from "@/shared/lib/subscriptionPlans";

/**
 * Owner-only pricing surface inside Settings.
 *
 * Renders three plan cards (free / pro / premium). Current plan gets a
 * gold border per `COLOR_TOKENS.md` §6 (gold = commitment / VIP /
 * "this is what you have"). Upgrade buttons redirect to a Stripe
 * Checkout session URL; a "Manage subscription" link redirects to
 * the Stripe Customer Portal.
 *
 * Reuses Card + Badge + Button primitives from `src/components/ui/`.
 */

export interface PricingPanelProps {
  slug: string;
  /** Current plan from `salons.subscription_plan`. */
  currentPlan: SubscriptionPlan;
  messages: ReceptionistMessages["pricing"];
}

const PLAN_KEYS: SubscriptionPlan[] = ["free", "pro", "premium"];

const PLAN_PRICE: Record<SubscriptionPlan, string> = {
  free: "$0",
  pro: "$39",
  premium: "$99",
};

export function PricingPanel({
  slug,
  currentPlan,
  messages,
}: PricingPanelProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onUpgrade = (plan: "pro" | "premium") => {
    setError(null);
    startTransition(async () => {
      const res = await createCheckoutSession(slug, plan);
      if (res.ok) {
        window.location.assign(res.url);
        return;
      }
      setError(messages.errors[res.error] ?? messages.errors.server_error);
    });
  };

  const onManage = () => {
    setError(null);
    startTransition(async () => {
      const res = await createCustomerPortalSession(slug);
      if (res.ok) {
        window.location.assign(res.url);
        return;
      }
      setError(
        messages.portalErrors[res.error] ?? messages.portalErrors.server_error,
      );
    });
  };

  return (
    <section
      data-testid="pricing-panel"
      className="space-y-3"
      aria-label={messages.sectionTitle}
    >
      <div>
        <h2 className="text-base font-semibold text-nq-foreground">
          {messages.sectionTitle}
        </h2>
        <p className="mt-1 text-xs text-nq-muted">{messages.sectionIntro}</p>
      </div>

      {error ? (
        <p
          role="alert"
          data-testid="pricing-error"
          className="rounded-md border border-nq-error/40 bg-nq-error/10 px-3 py-2 text-sm text-nq-error"
        >
          {error}
        </p>
      ) : null}

      <ul
        className="grid gap-3 sm:grid-cols-3"
        data-testid="pricing-plan-list"
      >
        {PLAN_KEYS.map((plan) => {
          const limits = PLAN_LIMITS[plan];
          const isCurrent = plan === currentPlan;
          const monthly = PLAN_PRICE[plan];
          return (
            <li key={plan} data-testid={`pricing-plan-${plan}`}>
              <Card
                variant="default"
                padding="md"
                className={cn(
                  "flex h-full flex-col gap-2",
                  isCurrent && "border-nq-primary ring-1 ring-nq-primary/45",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-nq-foreground">
                    {messages.planNames[plan]}
                  </h3>
                  {isCurrent ? (
                    <Badge variant="vip" state="default" size="sm">
                      {messages.currentBadge}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-2xl font-bold tabular-nums text-nq-foreground">
                  {monthly}
                  <span className="ml-1 text-xs font-normal text-nq-muted">
                    {messages.perMonth}
                  </span>
                </p>
                <ul className="mt-1 flex flex-col gap-1 text-xs text-nq-muted">
                  <li>
                    {messages.featureMaxStaff.replace(
                      "{n}",
                      Number.isFinite(limits.maxStaff)
                        ? String(limits.maxStaff)
                        : messages.unlimited,
                    )}
                  </li>
                  <li>
                    {messages.featureMaxServices.replace(
                      "{n}",
                      Number.isFinite(limits.maxServices)
                        ? String(limits.maxServices)
                        : messages.unlimited,
                    )}
                  </li>
                  <li
                    className={cn(
                      limits.hasReports
                        ? "text-nq-foreground/85"
                        : "line-through opacity-60",
                    )}
                  >
                    {messages.featureReports}
                  </li>
                  <li
                    className={cn(
                      limits.hasAuditLog
                        ? "text-nq-foreground/85"
                        : "line-through opacity-60",
                    )}
                  >
                    {messages.featureAuditLog}
                  </li>
                </ul>
                <div className="mt-auto pt-2">
                  {plan === "free" ? null : isCurrent ? (
                    <Button
                      type="button"
                      variant="secondary"
                      data-testid={`pricing-manage-${plan}`}
                      onClick={onManage}
                      loading={pending}
                      className="w-full"
                    >
                      {messages.manageSubscription}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="primary"
                      data-testid={`pricing-upgrade-${plan}`}
                      onClick={() => onUpgrade(plan)}
                      loading={pending}
                      className="w-full"
                    >
                      {messages.upgrade}
                    </Button>
                  )}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
