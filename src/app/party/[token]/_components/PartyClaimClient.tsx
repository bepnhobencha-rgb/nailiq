"use client";

/**
 * PartyClaimClient — interactive slot list + claim form for /party/[token].
 *
 * Each unclaimed slot shows a "Claim this slot" button that expands into
 * a mini-form (name + phone + reminder opt-in).  Already-claimed slots
 * show the claimant's first name with a checkmark.
 *
 * Security: phone numbers are never rendered — only the name shown after
 * claim is the member_name they chose to enter.
 */

import { useState, useTransition } from "react";
import { claimPartySlot } from "@/shared/booking/partyLinkActions";
import type { PartyLinkPageData, PartyLinkSlot } from "@/shared/booking/partyLinkActions";

export default function PartyClaimClient({ data }: { data: PartyLinkPageData }) {
  const [slots, setSlots] = useState<PartyLinkSlot[]>(data.slots);
  const [expandedClaimId, setExpandedClaimId] = useState<string | null>(null);

  function handleClaimed(claimId: string, name: string) {
    setSlots((prev) =>
      prev.map((s) =>
        s.claimId === claimId ? { ...s, claimed: true, claimedByName: name } : s,
      ),
    );
    setExpandedClaimId(null);
  }

  return (
    <div className="space-y-3">
      {slots.map((slot) => (
        <SlotCard
          key={slot.claimId}
          slot={slot}
          token={data.token}
          expired={data.expired}
          expanded={expandedClaimId === slot.claimId}
          onExpand={() =>
            setExpandedClaimId((prev) => (prev === slot.claimId ? null : slot.claimId))
          }
          onClaimed={handleClaimed}
        />
      ))}

      <p className="pt-2 text-center text-xs text-gray-400">
        Powered by{" "}
        <span className="font-semibold text-gray-600">NailIQ</span>
      </p>
    </div>
  );
}

// ─── SlotCard ─────────────────────────────────────────────────────

function SlotCard({
  slot,
  token,
  expired,
  expanded,
  onExpand,
  onClaimed,
}: {
  slot: PartyLinkSlot;
  token: string;
  expired: boolean;
  expanded: boolean;
  onExpand: () => void;
  onClaimed: (claimId: string, name: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      {/* Slot summary row */}
      <div className="flex items-center justify-between p-4">
        <div>
          <p className="font-semibold text-gray-900 text-sm">
            {slot.serviceName}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">
            {slot.staffName} · {slot.startDisplay} – {slot.endDisplay}
          </p>
        </div>

        {slot.claimed ? (
          <div className="flex items-center gap-1.5 text-emerald-600">
            <span className="text-lg">✓</span>
            <span className="text-sm font-medium">{slot.claimedByName ?? "Claimed"}</span>
          </div>
        ) : expired ? (
          <span className="text-xs text-gray-400 italic">Expired</span>
        ) : (
          <button
            onClick={onExpand}
            className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-700 transition-colors"
          >
            {expanded ? "Cancel" : "This is me"}
          </button>
        )}
      </div>

      {/* Expandable claim form */}
      {expanded && !slot.claimed && !expired && (
        <ClaimForm
          token={token}
          claimId={slot.claimId}
          onClaimed={(name) => onClaimed(slot.claimId, name)}
        />
      )}
    </div>
  );
}

// ─── ClaimForm ────────────────────────────────────────────────────

function ClaimForm({
  token,
  claimId,
  onClaimed,
}: {
  token: string;
  claimId: string;
  onClaimed: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [reminder, setReminder] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const nameTrim = name.trim();
    const phoneTrim = phone.trim();

    if (!nameTrim) { setError("Please enter your name."); return; }
    if (!phoneTrim) { setError("Please enter your phone number."); return; }

    startTransition(async () => {
      const result = await claimPartySlot({
        token,
        claimId,
        memberName: nameTrim,
        memberPhone: phoneTrim,
        reminderOptedIn: reminder,
      });

      if (result.ok) {
        onClaimed(nameTrim);
        return;
      }

      switch (result.reason) {
        case "already_claimed":
          setError("This slot was just claimed by someone else. Refresh to see who got it.");
          break;
        case "expired":
          setError("This party link has expired. Ask the organiser for a new one.");
          break;
        case "not_found":
          setError("This party link no longer exists.");
          break;
        case "invalid_input":
          setError("Please check your name and phone number (include country code, e.g. +1 604…).");
          break;
        default:
          setError("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-3"
    >
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">
          Your name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Sarah"
          maxLength={100}
          required
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">
          Phone number
        </label>
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+1 604 555 0123"
          required
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
        <p className="mt-1 text-xs text-gray-400">
          Include your country code (e.g. +1 for Canada/US, +84 for Vietnam).
        </p>
      </div>

      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={reminder}
          onChange={(e) => setReminder(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-900"
        />
        <span className="text-xs text-gray-600">
          Send me a reminder before my appointment
        </span>
      </label>

      {error && (
        <p className="text-xs text-red-600 font-medium">{error}</p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-lg bg-gray-900 py-2.5 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-60 transition-colors"
      >
        {isPending ? "Claiming…" : "Confirm my slot"}
      </button>
    </form>
  );
}
