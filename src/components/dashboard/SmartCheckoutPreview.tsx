"use client";

import { useState } from "react";
import { CreditCard, ReceiptText, ShieldCheck, Smartphone } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import {
  evaluateSmartCheckoutReadiness,
  quoteSmartCheckout,
  type SmartCheckoutProvider,
  type SmartCheckoutTender,
} from "@/shared/checkout/smartCheckout";
import { formatCurrency } from "@/shared/lib/currencyFormat";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type SimulationStep = "review" | "awaiting_customer" | "receipt";

type Props = {
  salonName: string;
  configuredProvider: SmartCheckoutProvider | null;
  providerConnected: boolean;
  smartCheckoutEnabled: boolean;
};

function dollarsToCents(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.round(parsed * 100)
    : -1;
}

function formatSignedCurrency(cents: number): string {
  const amount = formatCurrency(Math.abs(cents), "CAD") ?? "—";
  return cents < 0 ? `−${amount}` : amount;
}

const fieldClassName =
  "mt-1 min-h-11 w-full rounded-xl border border-nq-border bg-nq-bg px-3 text-sm text-nq-foreground outline-none focus-visible:ring-2 focus-visible:ring-nq-primary";

export function SmartCheckoutPreview({
  salonName,
  configuredProvider,
  providerConnected,
  smartCheckoutEnabled,
}: Props) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const [provider, setProvider] = useState<SmartCheckoutProvider>(
    configuredProvider ?? "square",
  );
  const [tender, setTender] = useState<SmartCheckoutTender>("terminal");
  const [serviceAmount, setServiceAmount] = useState("60");
  const [addonAmount, setAddonAmount] = useState("15");
  const [discountAmount, setDiscountAmount] = useState("5");
  const [taxAmount, setTaxAmount] = useState("3.50");
  const [tipAmount, setTipAmount] = useState("10");
  const [depositAmount, setDepositAmount] = useState("20");
  const [step, setStep] = useState<SimulationStep>("review");

  const result = quoteSmartCheckout({
    currency: "CAD",
    items: [
      {
        id: "preview-service",
        label: vi ? "Dịch vụ chính" : "Primary service",
        kind: "service",
        quantity: 1,
        unitAmountCents: dollarsToCents(serviceAmount),
      },
      {
        id: "preview-addon",
        label: "Add-on",
        kind: "addon",
        quantity: 1,
        unitAmountCents: dollarsToCents(addonAmount),
      },
    ],
    discountCents: dollarsToCents(discountAmount),
    taxCents: dollarsToCents(taxAmount),
    tipCents: dollarsToCents(tipAmount),
    depositPaidCents: dollarsToCents(depositAmount),
  });

  const selectedProviderConnected =
    provider === configuredProvider && providerConnected;
  const readiness = evaluateSmartCheckoutReadiness({
    selectedProvider: provider,
    providerConnected: selectedProviderConnected,
    payoutsReady: false,
    webhooksReady: false,
    deviceReady: false,
    dispatchEnabled: false,
  });

  const quote = result.ok ? result.quote : null;
  const amountDue = quote
    ? (formatCurrency(quote.amountDueCents, "CAD") ?? "—")
    : "—";
  const amountFields: Array<{
    label: string;
    value: string;
    setValue: (next: string) => void;
  }> = [
    {
      label: vi ? "Dịch vụ" : "Service",
      value: serviceAmount,
      setValue: setServiceAmount,
    },
    { label: "Add-on", value: addonAmount, setValue: setAddonAmount },
    {
      label: vi ? "Giảm giá" : "Discount",
      value: discountAmount,
      setValue: setDiscountAmount,
    },
    { label: vi ? "Thuế" : "Tax", value: taxAmount, setValue: setTaxAmount },
    { label: "Tip", value: tipAmount, setValue: setTipAmount },
    {
      label: vi ? "Cọc đã trả" : "Deposit paid",
      value: depositAmount,
      setValue: setDepositAmount,
    },
  ];

  function selectProvider(next: SmartCheckoutProvider) {
    setProvider(next);
    setTender("terminal");
    setStep("review");
  }

  return (
    <div className="space-y-5" data-testid="smart-checkout-preview">
      <Card variant="elevated" padding="lg">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="warning" dot>
                {vi ? "CHỈ MÔ PHỎNG · KHÔNG THU TIỀN" : "SIMULATION ONLY · NO CHARGE"}
              </Badge>
              <Badge variant={smartCheckoutEnabled ? "info" : "neutral"}>
                {smartCheckoutEnabled ? "Salon pilot ON" : "Salon pilot OFF"}
              </Badge>
            </div>
            <h1 className="mt-4 text-2xl font-semibold text-nq-foreground">
              Smart Checkout
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-nq-muted">
              {vi
                ? `${salonName}: kiểm tra toàn bộ trải nghiệm tính tiền Square hoặc Stripe mà không gửi yêu cầu tới thiết bị hay provider.`
                : `${salonName}: test the complete Square or Stripe checkout experience without sending anything to a device or provider.`}
            </p>
          </div>
          <ShieldCheck className="h-10 w-10 shrink-0 text-nq-primary" aria-hidden />
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
        <Card padding="lg">
          <h2 className="text-lg font-semibold text-nq-foreground">
            {vi ? "1. Chọn cách thu" : "1. Choose how to collect"}
          </h2>
          <div className="mt-4 grid grid-cols-2 gap-3">
            {(["square", "stripe"] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => selectProvider(item)}
                aria-pressed={provider === item}
                className={`min-h-12 rounded-xl border px-4 text-left text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-nq-primary ${
                  provider === item
                    ? "border-nq-primary bg-nq-primary/10 text-nq-primary"
                    : "border-nq-border bg-nq-bg text-nq-foreground"
                }`}
              >
                {item === "square" ? "Square Terminal" : "Stripe Terminal"}
              </button>
            ))}
          </div>

          <label className="mt-4 block text-sm font-medium text-nq-foreground">
            {vi ? "Thiết bị" : "Device path"}
            <select
              value={tender}
              onChange={(event) => {
                setTender(event.target.value as SmartCheckoutTender);
                setStep("review");
              }}
              className={fieldClassName}
            >
              <option value="terminal">
                {provider === "square" ? "Square Terminal" : "Stripe Terminal"}
              </option>
              {provider === "stripe" ? (
                <option value="tap_to_pay">Tap to Pay on iPhone/Android</option>
              ) : null}
            </select>
          </label>

          <h2 className="mt-7 text-lg font-semibold text-nq-foreground">
            {vi ? "2. Kiểm tra hóa đơn" : "2. Review the bill"}
          </h2>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {amountFields.map(({ label, value, setValue }) => (
              <label key={label} className="text-xs font-medium text-nq-muted">
                {label}
                <span className="relative block">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-nq-muted">
                    $
                  </span>
                  <input
                    inputMode="decimal"
                    value={value}
                    onChange={(event) => {
                      setValue(event.target.value);
                      setStep("review");
                    }}
                    className={`${fieldClassName} pl-7`}
                  />
                </span>
              </label>
            ))}
          </div>
          {!result.ok ? (
            <p className="mt-3 text-sm text-nq-error" role="alert">
              {vi ? "Số tiền chưa hợp lệ. Hãy kiểm tra lại." : "Invalid amount. Please review the bill."}
            </p>
          ) : null}
        </Card>

        <Card padding="lg" className="h-fit">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-nq-foreground">
              {vi ? "Tổng cần thu" : "Amount due"}
            </h2>
            <ReceiptText className="h-5 w-5 text-nq-primary" aria-hidden />
          </div>
          <p className="mt-3 text-4xl font-semibold tracking-tight text-nq-foreground">
            {amountDue}
          </p>
          {quote ? (
            <dl className="mt-5 space-y-2 border-t border-nq-border pt-4 text-sm">
              {[
                [vi ? "Tạm tính" : "Subtotal", quote.subtotalCents],
                [vi ? "Giảm giá" : "Discount", -quote.discountCents],
                [vi ? "Thuế" : "Tax", quote.taxCents],
                ["Tip", quote.tipCents],
                [vi ? "Trừ tiền cọc" : "Deposit credit", -quote.depositCreditCents],
              ].map(([label, cents]) => (
                <div key={String(label)} className="flex justify-between gap-3">
                  <dt className="text-nq-muted">{label}</dt>
                  <dd className="font-medium text-nq-foreground">
                    {formatSignedCurrency(Number(cents))}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}

          <div className="mt-6 rounded-xl border border-nq-border bg-nq-bg p-4">
            <div className="flex items-center gap-2">
              {step === "review" ? (
                <CreditCard className="h-5 w-5 text-nq-primary" aria-hidden />
              ) : (
                <Smartphone className="h-5 w-5 text-nq-primary" aria-hidden />
              )}
              <p className="font-semibold text-nq-foreground" aria-live="polite">
                {step === "review"
                  ? vi
                    ? "Chờ nhân viên duyệt"
                    : "Waiting for staff approval"
                  : step === "awaiting_customer"
                    ? vi
                      ? "Mô phỏng: chờ khách tap/insert"
                      : "Simulation: waiting for customer tap/insert"
                    : vi
                      ? "Mô phỏng: đã nhận receipt"
                      : "Simulation: receipt reconciled"}
              </p>
            </div>
            <p className="mt-2 text-xs leading-5 text-nq-muted">
              {vi
                ? "Không có API call. Không lưu thẻ. Không thay đổi booking."
                : "No API call, no card storage, and no booking mutation."}
            </p>
          </div>

          <div className="mt-4 flex flex-col gap-2">
            {step === "review" ? (
              <Button
                fullWidth
                disabled={!quote || quote.amountDueCents <= 0}
                onClick={() => setStep("awaiting_customer")}
              >
                {vi ? "Duyệt & mô phỏng gửi thiết bị" : "Approve & simulate device handoff"}
              </Button>
            ) : step === "awaiting_customer" ? (
              <Button fullWidth onClick={() => setStep("receipt")}>
                {vi ? "Mô phỏng receipt thành công" : "Simulate successful receipt"}
              </Button>
            ) : (
              <Button fullWidth variant="secondary" onClick={() => setStep("review")}>
                {vi ? "Làm lại mô phỏng" : "Reset simulation"}
              </Button>
            )}
          </div>
        </Card>
      </div>

      <Card padding="lg" variant="bordered">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-nq-foreground">
              {vi ? "Cổng tiền thật vẫn khóa an toàn" : "Live-money gates remain locked"}
            </h2>
            <p className="mt-1 text-sm text-nq-muted">
              {vi
                ? "Cần kết nối provider, payouts, webhook, thiết bị và bật dispatch theo từng salon."
                : "Provider, payouts, webhooks, device, and per-salon dispatch must all be proven."}
            </p>
          </div>
          <Badge variant={readiness.readyForLiveMoney ? "success" : "warning"}>
            {readiness.readyForLiveMoney ? "LIVE READY" : `${readiness.blockers.length} GATES LOCKED`}
          </Badge>
        </div>
        <ul className="mt-4 grid gap-2 text-sm text-nq-muted sm:grid-cols-2">
          {readiness.blockers.map((blocker) => (
            <li key={blocker} className="rounded-lg bg-nq-surface px-3 py-2">
              {blocker.replaceAll("_", " ")}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
