"use client";

/**
 * PartyClaimClient — interactive slot list + claim form for /party/[token].
 *
 * Each unclaimed slot shows a "Claim this slot" button that expands into
 * a mini-form (name + phone + reminder opt-in).  Already-claimed slots
 * show the claimant's first name with a checkmark.
 *
 * After claiming, the member sees two additional sections:
 *   • "Edit my details" — update name, phone, reminder (Part C).
 *   • "Need to change something?" — submit a service/staff/note request
 *     that salon staff will review (Part E).
 *
 * Security: phone numbers are never rendered — only the name shown after
 * claim is the member_name they chose to enter.
 */

import { useState, useTransition } from "react";
import {
  claimPartySlot,
  editPartyClaimDetails,
  submitPartyChangeRequest,
} from "@/shared/booking/partyLinkActions";
import type {
  PartyLinkPageData,
  PartyLinkSlot,
  PartyChangeRequestType,
} from "@/shared/booking/partyLinkActions";
import type { bookingEn } from "@/shared/i18n/booking/en";

type PartyPageT = (typeof bookingEn)["partyPage"];

interface Props {
  data: PartyLinkPageData;
  t: PartyPageT;
}

export default function PartyClaimClient({ data, t }: Props) {
  const [slots, setSlots] = useState<PartyLinkSlot[]>(data.slots);
  const [expandedClaimId, setExpandedClaimId] = useState<string | null>(null);
  /** claimId of the slot this browser session just claimed — unlocks Edit + Change sections. */
  const [myClaimedId, setMyClaimedId] = useState<string | null>(null);

  function handleClaimed(claimId: string, name: string) {
    setSlots((prev) =>
      prev.map((s) =>
        s.claimId === claimId ? { ...s, claimed: true, claimedByName: name } : s,
      ),
    );
    setExpandedClaimId(null);
    setMyClaimedId(claimId);
  }

  return (
    <div className="space-y-3">
      {slots.map((slot) => (
        <SlotCard
          key={slot.claimId}
          slot={slot}
          token={data.token}
          expired={data.expired}
          t={t}
          expanded={expandedClaimId === slot.claimId}
          isMySlot={myClaimedId === slot.claimId}
          onExpand={() =>
            setExpandedClaimId((prev) => (prev === slot.claimId ? null : slot.claimId))
          }
          onClaimed={handleClaimed}
        />
      ))}

      <p className="pt-2 text-center text-xs text-gray-400">
        {t.poweredBy}{" "}
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
  t,
  expanded,
  isMySlot,
  onExpand,
  onClaimed,
}: {
  slot: PartyLinkSlot;
  token: string;
  expired: boolean;
  t: PartyPageT;
  expanded: boolean;
  isMySlot: boolean;
  onExpand: () => void;
  onClaimed: (claimId: string, name: string) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);
  const [displayName, setDisplayName] = useState(slot.claimedByName ?? "");

  function handleEdited(newName: string) {
    setDisplayName(newName);
    setEditOpen(false);
  }

  /** Called by ClaimForm on success — updates local displayName immediately
   *  (useState does not re-initialize from prop changes, so we must set it
   *  here rather than relying on the parent's setSlots propagation). */
  function handleClaimedHere(name: string) {
    setDisplayName(name);
    onClaimed(slot.claimId, name);
  }

  return (
    <div
      data-testid={`party-slot-card-${slot.claimId}`}
      className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden"
    >
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
            <span className="text-sm font-medium">{displayName || t.claimed}</span>
          </div>
        ) : expired ? (
          <span className="text-xs text-gray-400 italic">{t.expiredLabel}</span>
        ) : (
          <button
            data-testid="party-claim-btn"
            onClick={onExpand}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700 transition-colors"
          >
            {expanded ? t.cancelBtn : t.claimBtn}
          </button>
        )}
      </div>

      {/* Expandable claim form (unclaimed only) */}
      {expanded && !slot.claimed && !expired && (
        <ClaimForm
          token={token}
          claimId={slot.claimId}
          t={t}
          onClaimed={handleClaimedHere}
        />
      )}

      {/* Post-claim controls — only shown on the slot claimed by this session */}
      {slot.claimed && isMySlot && !expired && (
        <div className="border-t border-gray-100 px-4 py-3 space-y-2">
          {/* Edit my details */}
          <button
            data-testid="party-edit-btn"
            onClick={() => { setEditOpen((v) => !v); setChangeOpen(false); }}
            className="w-full text-left text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors flex items-center gap-1.5 py-1"
          >
            <span>✏️</span>
            <span>{editOpen ? t.editDetailsCancel : t.editMyDetails}</span>
          </button>

          {editOpen && (
            <EditDetailsForm
              token={token}
              claimId={slot.claimId}
              initialName={displayName}
              t={t}
              onEdited={handleEdited}
              onCancel={() => setEditOpen(false)}
            />
          )}

          {/* Need to change something? */}
          {!editOpen && (
            <button
              data-testid="party-change-req-btn"
              onClick={() => setChangeOpen((v) => !v)}
              className="w-full text-left text-sm font-medium text-gray-500 hover:text-gray-900 transition-colors flex items-center gap-1.5 py-1"
            >
              <span>💬</span>
              <span>{t.needToChange}</span>
            </button>
          )}

          {changeOpen && !editOpen && (
            <ChangeRequestForm
              token={token}
              claimId={slot.claimId}
              bookingId={slot.bookingId}
              t={t}
              onClose={() => setChangeOpen(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─── ClaimForm ────────────────────────────────────────────────────

function ClaimForm({
  token,
  claimId,
  t,
  onClaimed,
}: {
  token: string;
  claimId: string;
  t: PartyPageT;
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

    if (!nameTrim) { setError(t.errNameRequired); return; }
    if (!phoneTrim) { setError(t.errPhoneRequired); return; }

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
        case "already_claimed": setError(t.errAlreadyClaimed); break;
        case "expired":         setError(t.errExpired);        break;
        case "not_found":       setError(t.errNotFound);       break;
        case "invalid_input":   setError(t.errInvalidInput);   break;
        default:                setError(t.errGeneric);
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
          {t.formNameLabel}
        </label>
        <input
          data-testid="party-claim-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t.formNamePlaceholder}
          maxLength={100}
          required
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">
          {t.formPhoneLabel}
        </label>
        <input
          data-testid="party-claim-phone"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder={t.formPhonePlaceholder}
          required
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
        <p className="mt-1 text-xs text-gray-400">{t.formPhoneHint}</p>
      </div>

      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={reminder}
          onChange={(e) => setReminder(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-900"
        />
        <span className="text-xs text-gray-600">{t.formReminderLabel}</span>
      </label>

      {error && (
        <p data-testid="party-claim-error" className="text-xs text-red-600 font-medium">{error}</p>
      )}

      <button
        data-testid="party-claim-submit"
        type="submit"
        disabled={isPending}
        className="w-full rounded-lg bg-gray-900 py-2.5 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-60 transition-colors"
      >
        {isPending ? t.formSubmitting : t.formSubmit}
      </button>
    </form>
  );
}

// ─── EditDetailsForm ──────────────────────────────────────────────

function EditDetailsForm({
  token,
  claimId,
  initialName,
  t,
  onEdited,
  onCancel,
}: {
  token: string;
  claimId: string;
  initialName: string;
  t: PartyPageT;
  onEdited: (newName: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState("");
  const [reminder, setReminder] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const nameTrim = name.trim();
    const phoneTrim = phone.trim();

    if (!nameTrim) { setError(t.editDetailsErrName);  return; }
    if (!phoneTrim) { setError(t.editDetailsErrPhone); return; }

    startTransition(async () => {
      const result = await editPartyClaimDetails({
        token,
        claimId,
        memberName:      nameTrim,
        memberPhone:     phoneTrim,
        reminderOptedIn: reminder,
      });

      if (result.ok) {
        setSuccess(true);
        setTimeout(() => {
          onEdited(nameTrim);
        }, 1200);
        return;
      }

      if (result.reason === "invalid_input") {
        setError(t.editDetailsErrPhone);
      } else {
        setError(t.editDetailsErrGeneric);
      }
    });
  }

  if (success) {
    return (
      <p className="text-xs text-emerald-600 font-medium py-1">
        ✓ {t.editDetailsSuccess}
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2 pt-1">
      <p className="text-xs font-semibold text-gray-700">{t.editDetailsHeading}</p>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">
          {t.formNameLabel}
        </label>
        <input
          data-testid="party-edit-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t.formNamePlaceholder}
          maxLength={100}
          required
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">
          {t.formPhoneLabel}
        </label>
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder={t.formPhonePlaceholder}
          required
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>

      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={reminder}
          onChange={(e) => setReminder(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-900"
        />
        <span className="text-xs text-gray-600">{t.formReminderLabel}</span>
      </label>

      {error && <p className="text-xs text-red-600 font-medium">{error}</p>}

      <div className="flex gap-2">
        <button
          data-testid="party-edit-submit"
          type="submit"
          disabled={isPending}
          className="flex-1 rounded-lg bg-gray-900 py-2.5 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-60 transition-colors"
        >
          {isPending ? t.editDetailsSaving : t.editDetailsSave}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-gray-300 px-3 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
        >
          {t.editDetailsCancel}
        </button>
      </div>
    </form>
  );
}

// ─── ChangeRequestForm ────────────────────────────────────────────

const CHANGE_REQUEST_TYPES: { type: PartyChangeRequestType; labelKey: "changeServiceBtn" | "changeStaffBtn" | "addNoteBtn" }[] = [
  { type: "service_change",    labelKey: "changeServiceBtn" },
  { type: "staff_preference",  labelKey: "changeStaffBtn"   },
  { type: "note",              labelKey: "addNoteBtn"        },
];

function ChangeRequestForm({
  token,
  claimId,
  bookingId,
  t,
  onClose,
}: {
  token: string;
  claimId: string;
  bookingId: string;
  t: PartyPageT;
  onClose: () => void;
}) {
  const [selectedType, setSelectedType] = useState<PartyChangeRequestType | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedType) return;
    setError(null);

    startTransition(async () => {
      const result = await submitPartyChangeRequest({
        token,
        claimId,
        bookingId,
        requestType: selectedType,
        note:        note.trim() || undefined,
      });

      if (result.ok) {
        setSuccess(true);
        return;
      }

      setError(t.changeRequestErrGeneric);
    });
  }

  if (success) {
    return (
      <div className="space-y-2 pt-1">
        <p data-testid="party-change-req-success" className="text-sm text-emerald-600 font-medium">✓ {t.changeRequestSuccess}</p>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-gray-500 underline"
        >
          {t.changeRequestClose}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2 pt-1">
      <p className="text-xs text-gray-500">{t.changeRequestHint}</p>

      {/* Request type selection */}
      <div className="flex flex-wrap gap-2">
        {CHANGE_REQUEST_TYPES.map(({ type, labelKey }) => (
          <button
            key={type}
            type="button"
            onClick={() => setSelectedType(type)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors border ${
              selectedType === type
                ? "bg-gray-900 text-white border-gray-900"
                : "bg-white text-gray-700 border-gray-300 hover:border-gray-500"
            }`}
          >
            {t[labelKey]}
          </button>
        ))}
      </div>

      {/* Note field (always shown once a type is selected) */}
      {selectedType && (
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t.changeRequestNotePlaceholder}
          maxLength={500}
          rows={3}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 resize-none"
        />
      )}

      {error && <p className="text-xs text-red-600 font-medium">{error}</p>}

      <div className="flex gap-2">
        <button
          data-testid="party-change-req-submit"
          type="submit"
          disabled={isPending || !selectedType}
          className="flex-1 rounded-lg bg-gray-900 py-2.5 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-60 transition-colors"
        >
          {isPending ? t.changeRequestSubmitting : t.changeRequestSubmit}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-gray-300 px-3 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
        >
          {t.editDetailsCancel}
        </button>
      </div>
    </form>
  );
}
