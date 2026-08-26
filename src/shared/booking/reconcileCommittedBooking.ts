import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  logBookingEvent,
  type LogBookingEventInput,
} from "@/shared/dashboard/auditLog";
import {
  sendOwnerBookingNotification,
  type OwnerNotifyInput,
} from "@/shared/dashboard/sendOwnerBookingNotification";
import { handleBookingProtection } from "@/shared/noshow/handleBookingProtection";

type ProtectionChannel = Parameters<typeof handleBookingProtection>[2];

export type CommittedBookingJob = {
  name: string;
  run: () => Promise<unknown>;
};

export type CommittedBookingReconciliationInput = {
  bookingId: string;
  salonId: string;
  channel: "voice" | "desk";
  stamp?: () => Promise<unknown>;
  ownerNotify?: OwnerNotifyInput;
  audit?: Omit<LogBookingEventInput, "bookingId" | "salonId">;
  protectionChannel?: ProtectionChannel;
  jobs?: CommittedBookingJob[];
};

type ReconciliationDependencies = {
  ownerNotify: typeof sendOwnerBookingNotification;
  protect: typeof handleBookingProtection;
  auditExists: (input: {
    bookingId: string;
    salonId: string;
    eventType: LogBookingEventInput["eventType"];
    reconciliationKey: string;
  }) => Promise<boolean>;
  audit: typeof logBookingEvent;
};

function reconciliationKey(input: CommittedBookingReconciliationInput): string {
  return `post_commit:${input.channel}:${input.bookingId}`;
}

async function persistedAuditExists(input: {
  bookingId: string;
  salonId: string;
  eventType: LogBookingEventInput["eventType"];
  reconciliationKey: string;
}): Promise<boolean> {
  try {
    const { data, error } = await createServiceRoleClient()
      .from("booking_events" as never)
      .select("id")
      .eq("booking_id", input.bookingId)
      .eq("salon_id", input.salonId)
      .eq("event_type", input.eventType)
      .contains("payload", {
        postCommitReconciliationKey: input.reconciliationKey,
      } as never)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[reconcileCommittedBooking] audit lookup", error);
      return false;
    }
    return data != null;
  } catch (error) {
    console.error("[reconcileCommittedBooking] audit lookup threw", error);
    return false;
  }
}

const defaultDependencies: ReconciliationDependencies = {
  ownerNotify: sendOwnerBookingNotification,
  protect: handleBookingProtection,
  auditExists: persistedAuditExists,
  audit: logBookingEvent,
};

async function settle(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error(`[reconcileCommittedBooking] ${name} threw`, error);
  }
}

/**
 * Reconcile the side effects of an already-committed individual booking.
 *
 * Both the first successful create and response-loss replay call this function.
 * Database stamps/session links/no-show evaluation are idempotent, while owner
 * and customer notification jobs use their existing durable delivery claims.
 * The audit lookup prevents the normal sequential retry from appending the same
 * created event twice. No availability or pricing resolution happens here.
 */
export async function reconcileCommittedBooking(
  input: CommittedBookingReconciliationInput,
  dependencies: ReconciliationDependencies = defaultDependencies,
): Promise<void> {
  if (!input.bookingId || !input.salonId) return;

  // Stamp first so notification readers see the correct source/channel.
  if (input.stamp) await settle("stamp", input.stamp);

  const jobs: CommittedBookingJob[] = [...(input.jobs ?? [])];
  if (input.ownerNotify) {
    jobs.push({
      name: "owner notification",
      run: () => dependencies.ownerNotify(input.ownerNotify!),
    });
  }
  if (input.protectionChannel) {
    jobs.push({
      name: "no-show protection",
      run: () =>
        dependencies.protect(
          input.bookingId,
          input.salonId,
          input.protectionChannel!,
        ),
    });
  }
  if (input.audit) {
    const key = reconciliationKey(input);
    jobs.push({
      name: "booking audit",
      run: async () => {
        const exists = await dependencies.auditExists({
          bookingId: input.bookingId,
          salonId: input.salonId,
          eventType: input.audit!.eventType,
          reconciliationKey: key,
        });
        if (exists) return;
        await dependencies.audit({
          ...input.audit!,
          bookingId: input.bookingId,
          salonId: input.salonId,
          payload: {
            ...(input.audit!.payload ?? {}),
            postCommitReconciliationKey: key,
          },
        });
      },
    });
  }

  await Promise.all(jobs.map((job) => settle(job.name, job.run)));
}
