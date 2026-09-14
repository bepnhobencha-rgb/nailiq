"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { OnlineWaitlistPanel } from "@/components/receptionist/OnlineWaitlistPanel";
import type { ReceptionistCenterData } from "@/shared/dashboard/loadReceptionistCenterData";
import { UserLanguageProvider } from "@/shared/lib/UserLanguageContext";

type WaitlistEntry = ReceptionistCenterData["onlineWaitlist"][number];

const baseEntry: Omit<WaitlistEntry, "id" | "clientName" | "delivery"> = {
  serviceId: "00000000-0000-4000-8000-000000000001",
  serviceName: "Synthetic Head Spa",
  bookingDate: "2026-09-20",
  preferredSlotLabel: "2:00 PM",
  phone: "+16045550123",
  email: "qa@example.test",
  preferredStaffName: null,
  source: "slot_unavailable",
  status: "notified",
  requestKind: "individual",
  partySize: 1,
  serviceCount: 1,
  claimedAt: null,
  offeredStaffId: null,
  createdAt: "2026-09-14T15:00:00.000Z",
};

const entries: WaitlistEntry[] = [
  {
    ...baseEntry,
    id: "delivery-accepted",
    clientName: "QA Accepted",
    delivery: {
      offerEpoch: 1,
      sms: { status: "accepted", reason: null, updatedAt: "2026-09-14T15:01:00.000Z" },
      email: { status: "delivered", reason: null, updatedAt: "2026-09-14T15:02:00.000Z" },
    },
  },
  {
    ...baseEntry,
    id: "delivery-failed",
    clientName: "QA Failed",
    delivery: {
      offerEpoch: 1,
      sms: { status: "failed", reason: "provider_rejected", updatedAt: "2026-09-14T15:03:00.000Z" },
      email: { status: "suppressed", reason: "recipient_suppressed", updatedAt: "2026-09-14T15:04:00.000Z" },
    },
  },
  {
    ...baseEntry,
    id: "delivery-unknown",
    clientName: "QA Unknown",
    delivery: {
      offerEpoch: 1,
      sms: { status: "unknown", reason: "outcome_unknown", updatedAt: "2026-09-14T15:05:00.000Z" },
      email: { status: "sending", reason: null, updatedAt: "2026-09-14T15:06:00.000Z" },
    },
  },
];

function AcceptancePanel({ language }: { language: "en" | "vi" }) {
  return (
    <UserLanguageProvider initialLanguage={language}>
      <main className="mx-auto min-h-dvh max-w-2xl bg-nq-surface py-4">
        <header className="px-3 pb-3">
          <h1 className="text-lg font-semibold">
            {language === "vi" ? "Nghiệm thu trạng thái giao tin" : "Delivery status acceptance"}
          </h1>
          <p className="mt-1 text-sm text-nq-muted">
            {language === "vi"
              ? "Dữ liệu synthetic, không gửi tin và không gọi provider."
              : "Synthetic data; no message or provider call."}
          </p>
        </header>
        <OnlineWaitlistPanel slug="e2e-waitlist-delivery" entries={entries} />
      </main>
    </UserLanguageProvider>
  );
}

function Fixture() {
  const params = useSearchParams();
  const language = params.get("lang") === "vi" ? "vi" : "en";
  return <AcceptancePanel language={language} />;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Fixture />
    </Suspense>
  );
}
