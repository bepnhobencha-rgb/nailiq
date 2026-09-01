import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  emptyWaitlistDeliveryTruth,
  summarizeWaitlistDeliveryTruth,
  type WaitlistDeliveryTruth,
  type WaitlistDeliveryTruthRow,
} from "@/shared/noshow/waitlistDeliveryTruth";

type ClaimStateRow = {
  waitlist_entry_id: unknown;
  epoch: unknown;
};

export type WaitlistDeliveryTruthLoad = {
  available: boolean;
  truthByEntry: Map<string, WaitlistDeliveryTruth>;
};

function unavailableTruth(entryIds: readonly string[]): WaitlistDeliveryTruthLoad {
  return {
    available: false,
    truthByEntry: new Map(
      entryIds.map((entryId) => [entryId, emptyWaitlistDeliveryTruth()]),
    ),
  };
}

/**
 * Loads only same-salon, current-epoch outbox outcomes. Provider receipts,
 * recipients and fingerprints never cross this server-only boundary.
 */
export async function loadWaitlistDeliveryTruth(input: {
  salonId: string;
  entryIds: readonly string[];
  knownEpochs?: ReadonlyMap<string, number>;
}): Promise<WaitlistDeliveryTruthLoad> {
  const entryIds = [...new Set(input.entryIds.map((id) => id.trim()).filter(Boolean))];
  if (entryIds.length === 0) {
    return { available: true, truthByEntry: new Map() };
  }

  try {
    const service = createServiceRoleClient();
    let entryEpochs = new Map(input.knownEpochs ?? []);
    if (entryEpochs.size === 0) {
      const { data, error } = await service
        .from("waitlist_claim_action_state" as never)
        .select("waitlist_entry_id, epoch")
        .eq("salon_id", input.salonId)
        .in("waitlist_entry_id", entryIds);
      if (error) return unavailableTruth(entryIds);
      entryEpochs = new Map<string, number>();
      for (const row of (data ?? []) as unknown as ClaimStateRow[]) {
        const entryId =
          typeof row.waitlist_entry_id === "string"
            ? row.waitlist_entry_id.trim()
            : "";
        if (
          entryId &&
          typeof row.epoch === "number" &&
          Number.isSafeInteger(row.epoch) &&
          row.epoch > 0
        ) {
          entryEpochs.set(entryId, row.epoch);
        }
      }
    }

    const epochs = [...new Set(entryEpochs.values())];
    if (epochs.length === 0) return unavailableTruth(entryIds);
    const { data, error } = await service
      .from("waitlist_offer_delivery_outbox" as never)
      .select(
        "waitlist_entry_id, offer_epoch, channel, status, error_code, updated_at",
      )
      .eq("salon_id", input.salonId)
      .in("waitlist_entry_id", entryIds)
      .in("offer_epoch", epochs);
    if (error) return unavailableTruth(entryIds);

    const truthByEntry = summarizeWaitlistDeliveryTruth(
      entryEpochs,
      (data ?? []) as unknown as WaitlistDeliveryTruthRow[],
    );
    for (const entryId of entryIds) {
      if (!truthByEntry.has(entryId)) {
        truthByEntry.set(entryId, emptyWaitlistDeliveryTruth());
      }
    }
    return {
      available: true,
      truthByEntry,
    };
  } catch {
    return unavailableTruth(entryIds);
  }
}
