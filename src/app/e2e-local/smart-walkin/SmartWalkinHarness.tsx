"use client";

import { useState } from "react";

import {
  WalkinQueueSidebar,
  type QueueItem,
} from "@/components/receptionist/WalkinQueueSidebar";
import { getUserMessages } from "@/shared/i18n/user";

const SERVICE_ID = "00000000-0000-4000-8000-000000000101";

export function SmartWalkinHarness({
  observedAtIso,
}: {
  observedAtIso: string;
}) {
  const messages = getUserMessages("en");
  const queue = messages.receptionist.queue;
  const [items, setItems] = useState<QueueItem[]>([
    {
      id: "00000000-0000-4000-8000-000000000201",
      client_name: "Synthetic Guest",
      client_phone: null,
      client_email: null,
      sms_consent_at: null,
      service_id: SERVICE_ID,
      service_name: "Classic manicure",
      service_duration_minutes: 45,
      staff_request_note: null,
      joined_queue_at: observedAtIso,
    },
  ]);

  return (
    <main className="min-h-screen bg-nq-bg p-4 text-nq-foreground">
      <div className="mx-auto h-[min(900px,calc(100vh-2rem))] w-full max-w-sm overflow-hidden rounded-2xl border border-nq-border bg-nq-surface shadow-nq-card">
        <WalkinQueueSidebar
          items={items}
          assigningId={null}
          services={[
            {
              id: SERVICE_ID,
              name: "Classic manicure",
              duration_minutes: 45,
              buffer_minutes: 10,
              price_cents: 3500,
              price_type: "fixed",
              price_max_cents: null,
            },
          ]}
          currency="CAD"
          nowIso={observedAtIso}
          timezone="America/Vancouver"
          autoAssignEnabled={false}
          waitLinkEnabled={false}
          onAddWalkin={async (input) => {
            setItems((current) => [
              ...current,
              {
                id: input.requestId,
                client_name: input.clientName,
                client_phone: input.clientPhone,
                client_email: null,
                sms_consent_at: null,
                service_id: input.serviceId,
                service_name: "Classic manicure",
                service_duration_minutes: 55,
                staff_request_note: input.staffRequestNote,
                staff_requested_by_client: input.staffRequestedByClient,
                joined_queue_at: input.actualArrivalAtIso,
                walkin_source: input.walkinSource,
                walkin_priority: input.walkinPriority,
                walkin_request_tags: input.walkinRequestTags,
              },
            ]);
            return { ok: true };
          }}
          onUpdateContact={async ({ bookingId, clientPhone, clientEmail }) => {
            setItems((current) =>
              current.map((item) =>
                item.id === bookingId
                  ? {
                      ...item,
                      client_phone: clientPhone,
                      client_email: clientEmail,
                    }
                  : item,
              ),
            );
            return { ok: true };
          }}
          onSetSoftHold={async (bookingId, minutes) => {
            const holdUntilIso = new Date(
              Date.parse(observedAtIso) + minutes * 60_000,
            ).toISOString();
            setItems((current) =>
              current.map((item) =>
                item.id === bookingId
                  ? { ...item, soft_hold_until: holdUntilIso }
                  : item,
              ),
            );
            return { ok: true, holdUntilIso };
          }}
          onClearSoftHold={async (bookingId) => {
            setItems((current) =>
              current.map((item) =>
                item.id === bookingId
                  ? { ...item, soft_hold_until: null }
                  : item,
              ),
            );
            return { ok: true };
          }}
          onCancelWalkin={async (bookingId) =>
            setItems((current) => current.filter((item) => item.id !== bookingId))
          }
          onStartAssign={() => undefined}
          onCancelAssign={() => undefined}
          labels={{
            title: queue.title,
            removedGuest: messages.receptionist.removedGuest,
            emptyMessage: queue.emptyMessage,
            cancelButton: queue.cancelButton,
            assignButton: queue.assignButton,
            urgentBadge: queue.urgentBadge,
            waitingHint: queue.waitingHint,
            minutesAgo: queue.minutesAgo,
            sortLabel: queue.sortLabel,
            sortFifo: queue.sortFifo,
            sortLongestWait: queue.sortLongestWait,
            sortCustom: queue.sortCustom,
            avgWait: queue.avgWait,
            priorityHigh: queue.priorityHigh,
            priorityMedium: queue.priorityMedium,
            priorityLow: queue.priorityLow,
            partySizeLabel: queue.partySizeLabel,
            sourceFallback: queue.sourceFallback,
            waitHeroSuffix: queue.waitHeroSuffix,
            vipAria: queue.vipAria,
            readyAroundShort: queue.readyAroundShort,
            requestedByClientLine: queue.requestedByClientLine,
            overloadBanner: queue.overloadBanner,
            overloadBannerDismiss: queue.overloadBannerDismiss,
            softHoldButton: queue.softHoldButton,
            softHoldClear: queue.softHoldClear,
            softHoldLabel: queue.softHoldLabel,
            softHoldCountdown: queue.softHoldCountdown,
            waitLinkButton: queue.waitLinkButton,
            waitLinkModal: queue.waitLinkModal,
            contact: queue.contact,
            addForm: {
              ...queue.addForm,
              invalidPhone: messages.receptionist.walkin.invalidPhone,
              nameRequired: messages.receptionist.walkin.nameRequired,
              nameTooLong: messages.receptionist.walkin.nameTooLong,
              invalidNameChars: messages.receptionist.walkin.invalidNameChars,
            },
          }}
        />
      </div>
    </main>
  );
}
