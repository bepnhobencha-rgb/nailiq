"use client";

/**
 * PartyClaimClient — interactive slot list + claim form for /party/[token].
 *
 * Each unclaimed slot shows a "This is me" button that expands into a mini-form
 * (name + phone + reminder opt-in).  Already-claimed slots show the claimant's
 * name with a confirmed badge.
 *
 * After claiming, the member sees two additional sections:
 *   • "Edit my details" — update name, phone, reminder (Part C).
 *   • "Need to change something?" — submit a service/staff/note request
 *     that salon staff will review (Part E).
 *
 * Security: phone numbers are never rendered — only the name shown after
 * claim is the member_name they chose to enter.
 *
 * Styling: premium light "invitation" theme (warm cream + white cards +
 * espresso/gold accents). UI-only — claim/edit/change/wave behaviour is
 * unchanged.
 */

import { useEffect, useRef, useState, useTransition } from "react";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
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

// ─── Shared style tokens (premium light theme) ───────────────────
const INPUT_CLASS =
  "w-full rounded-xl border border-[#d9cdb9] bg-white px-3.5 py-2.5 text-sm text-[#2c2620] placeholder:text-[#a99e8c] focus:border-[#bfa063] focus:outline-none focus:ring-2 focus:ring-[#bfa063]/40";
const PRIMARY_BTN =
  "rounded-xl bg-[#2c2620] text-white font-semibold shadow-sm transition-colors hover:bg-[#433b30] active:bg-[#1f1b16] disabled:opacity-60";
const SECONDARY_BTN =
  "rounded-xl border border-[#d9cdb9] text-sm font-medium text-[#6b6155] transition-colors hover:bg-[#f6f1ea]";

function CheckCircle({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.7-9.3a1 1 0 00-1.4-1.4L9 10.6 7.7 9.3a1 1 0 00-1.4 1.4l2 2a1 1 0 001.4 0l4-4z"
        clipRule="evenodd"
      />
    </svg>
  );
}

// ─── ICS generation (Add to Calendar) ────────────────────────────
function buildIcsContent({
  title,
  startUtcIso,
  endUtcIso,
  description,
  location,
}: {
  title: string;
  startUtcIso: string;
  endUtcIso: string;
  description: string;
  location?: string;
}): string {
  const fmt = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d+/, "").replace("Z", "") + "Z";
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const uid = `nailiq-${Date.now()}@nailiq.ca`;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NailIQ//Party Guest Passport//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTART:${fmt(startUtcIso)}`,
    `DTEND:${fmt(endUtcIso)}`,
    `SUMMARY:${esc(title)}`,
    `DESCRIPTION:${esc(description)}`,
    location ? `LOCATION:${esc(location)}` : "",
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean).join("\r\n");
}

function AddToCalendarButton({
  slot,
  salonName,
  t,
}: {
  slot: PartyLinkSlot;
  salonName: string;
  t: PartyPageT;
}) {
  function handleClick() {
    if (!slot.startUtcIso || !slot.endUtcIso) return;
    const title = `${slot.serviceName} at ${salonName}`;
    const description = `${slot.serviceName} with ${slot.staffName} at ${salonName}.`;
    const ics = buildIcsContent({ title, startUtcIso: slot.startUtcIso, endUtcIso: slot.endUtcIso, description, location: salonName });
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "appointment.ics";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <button
      type="button"
      data-testid="party-add-to-calendar"
      onClick={handleClick}
      className="flex w-full items-center justify-center gap-2 rounded-xl border border-[#d9cdb9] bg-white py-2.5 text-sm font-medium text-[#6b6155] transition-colors hover:bg-[#f6f1ea]"
    >
      <span aria-hidden>📅</span>
      {t.addToCalendarBtn}
    </button>
  );
}

// ─── Group progress bar ────────────────────────────────────────────
function GroupProgress({ slots, t }: { slots: PartyLinkSlot[]; t: PartyPageT }) {
  const total = slots.length;
  const confirmed = slots.filter((s) => s.claimed).length;
  const pending = total - confirmed;
  const pct = total > 0 ? Math.round((confirmed / total) * 100) : 0;

  return (
    <div data-testid="party-group-progress" className="rounded-2xl border border-[#ece3d5] bg-white px-5 py-4 shadow-[0_1px_3px_rgba(120,90,50,0.05)]">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-sm font-semibold text-[#2c2620]">
          {t.groupProgressLabel.replace("{confirmed}", String(confirmed)).replace("{total}", String(total))}
        </span>
        {pending > 0 && (
          <span className="text-xs text-[#a99e8c]">
            {t.groupProgressPending.replace("{pending}", String(pending))}
          </span>
        )}
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-[#f0e7d8]">
        <div
          className="h-2 rounded-full bg-emerald-500 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ─── Personal Pass (shown after claim) ────────────────────────────
function PersonalPass({
  slot,
  displayName,
  salonName,
  showAddToCalendar,
  showArrivalNote,
  t,
}: {
  slot: PartyLinkSlot;
  displayName: string;
  salonName: string;
  showAddToCalendar: boolean;
  showArrivalNote: boolean;
  t: PartyPageT;
}) {
  const waveNote = slot.waveNumber > 1
    ? t.waveNoteTemplate.replace("{waveLabel}", `${t.waveLabel} ${slot.waveNumber}`)
    : null;

  return (
    <div
      data-testid="party-personal-pass"
      className="border-t border-[#f0e7d8] bg-gradient-to-b from-[#fcf9f4] to-[#f8f4ed] px-4 pb-4 pt-4"
    >
      {/* Pass header */}
      <div className="mb-3 flex items-center gap-2">
        <span className="text-base" aria-hidden>🎟️</span>
        <p className="text-sm font-bold text-[#9c7b43]">{t.personalPassTitle}</p>
      </div>

      {/* Appointment details */}
      <div className="rounded-xl border border-[#ece3d5] bg-white px-4 py-3 shadow-sm">
        <p className="text-[15px] font-semibold text-[#2c2620]">{slot.serviceName}</p>
        <p className="mt-1 text-xs text-[#857a6c]">{slot.staffName}</p>
        <p className="mt-1 text-sm font-medium text-[#4a3f2f]">
          {slot.startDisplay} – {slot.endDisplay}
        </p>
        {displayName && (
          <div className="mt-2 flex items-center gap-1.5">
            <CheckCircle className="h-4 w-4 text-emerald-500" />
            <span className="text-xs font-semibold text-emerald-700">{displayName}</span>
          </div>
        )}
      </div>

      {/* Wave note */}
      {waveNote && (
        <p className="mt-2.5 rounded-lg bg-[#f3e8d4] px-3 py-2 text-xs text-[#8a6a33]">
          🌊 {waveNote}
        </p>
      )}

      {/* Arrival note */}
      {showArrivalNote && (
        <p className="mt-2 text-xs text-[#857a6c]">⏰ {t.arrivalNote}</p>
      )}

      {/* Add to calendar */}
      {showAddToCalendar && slot.startUtcIso && slot.endUtcIso && (
        <div className="mt-3">
          <AddToCalendarButton slot={slot} salonName={salonName} t={t} />
        </div>
      )}
    </div>
  );
}

export default function PartyClaimClient({ data, t }: Props) {
  const [slots, setSlots] = useState<PartyLinkSlot[]>(data.slots);
  const [expandedClaimId, setExpandedClaimId] = useState<string | null>(null);
  /** claimId of the slot this browser session just claimed — unlocks Personal Pass + Edit + Change. */
  const [myClaimedId, setMyClaimedId] = useState<string | null>(null);
  const cfg = data.partyConfig;

  function handleClaimed(claimId: string, name: string) {
    setSlots((prev) =>
      prev.map((s) =>
        s.claimId === claimId ? { ...s, claimed: true, claimedByName: name } : s,
      ),
    );
    setExpandedClaimId(null);
    setMyClaimedId(claimId);
  }

  const renderSlot = (slot: PartyLinkSlot) => (
    <SlotCard
      key={slot.claimId}
      slot={slot}
      token={data.token}
      salonId={data.salonId}
      salonName={data.salonName}
      expired={data.expired}
      t={t}
      partyConfig={cfg}
      expanded={expandedClaimId === slot.claimId}
      isMySlot={myClaimedId === slot.claimId}
      onExpand={() =>
        setExpandedClaimId((prev) => (prev === slot.claimId ? null : slot.claimId))
      }
      onClaimed={handleClaimed}
    />
  );

  // Phase 6 — group by wave. Single-wave groups render exactly as before.
  const waveNumbers = [...new Set(slots.map((s) => s.waveNumber))].sort((a, b) => a - b);
  const isMultiWave = waveNumbers.length > 1;

  return (
    <div className="space-y-4">
      {/* Group progress (Part C) */}
      {cfg.showGroupProgress && slots.length > 1 && (
        <GroupProgress slots={slots} t={t} />
      )}

      {isMultiWave
        ? waveNumbers.map((wn) => {
            const waveSlots = slots.filter((s) => s.waveNumber === wn);
            const waveStart = waveSlots[0]?.startDisplay ?? "";
            return (
              <section key={wn} data-testid={`party-wave-${wn}`} className="space-y-2.5">
                {/* Wave header */}
                <div className="flex items-center gap-2.5 px-0.5">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f3e8d4] px-3 py-1 text-xs font-bold text-[#8a6a33]">
                    <span aria-hidden>🌊</span> {t.waveLabel} {wn}
                  </span>
                  {waveStart && (
                    <span className="text-xs font-medium text-[#857a6c]">{waveStart}</span>
                  )}
                  <span className="ml-auto text-xs text-[#a99e8c]">
                    {t.waveGuestCount.replace("{count}", String(waveSlots.length))}
                  </span>
                </div>
                <div className="space-y-2.5">{waveSlots.map(renderSlot)}</div>
              </section>
            );
          })
        : <div className="space-y-2.5">{slots.map(renderSlot)}</div>}

      <p className="pt-2 text-center text-xs text-[#a99e8c]">
        {t.poweredBy}{" "}
        <span className="font-semibold text-[#857a6c]">NailIQ</span>
      </p>
    </div>
  );
}

// ─── SlotCard ─────────────────────────────────────────────────────

function SlotCard({
  slot,
  token,
  salonId,
  salonName,
  expired,
  t,
  partyConfig,
  expanded,
  isMySlot,
  onExpand,
  onClaimed,
}: {
  slot: PartyLinkSlot;
  token: string;
  salonId: string;
  salonName: string;
  expired: boolean;
  t: PartyPageT;
  partyConfig: PartyLinkPageData["partyConfig"];
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

  // Localise the "Guest N" placeholder for display (VI → "Khách N").
  const guestLabelDisplay = /^Guest \d+$/.test(slot.guestLabel)
    ? slot.guestLabel.replace("Guest", t.guestWord)
    : slot.guestLabel;

  return (
    <div
      data-testid={`party-slot-card-${slot.claimId}`}
      className="overflow-hidden rounded-2xl border border-[#ece3d5] bg-white shadow-[0_1px_3px_rgba(120,90,50,0.05),0_10px_24px_-18px_rgba(120,90,50,0.22)]"
    >
      {/* Slot summary row */}
      <div className="flex items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold text-[#2c2620]">
            {slot.serviceName}
          </p>
          <p className="mt-0.5 text-xs text-[#857a6c]">
            {slot.staffName} · {slot.startDisplay} – {slot.endDisplay}
          </p>
        </div>

        {slot.claimed ? (
          <div className="flex shrink-0 items-center gap-2">
            <CheckCircle className="h-5 w-5 text-emerald-600" />
            <div className="text-right leading-tight">
              {displayName ? (
                <>
                  <p className="text-sm font-semibold text-[#2c2620]">{displayName}</p>
                  <p className="text-[11px] font-medium text-emerald-600">{t.claimed}</p>
                </>
              ) : (
                <p className="text-sm font-semibold text-emerald-600">{t.claimed}</p>
              )}
            </div>
          </div>
        ) : expired ? (
          <span className="shrink-0 text-xs italic text-[#a99e8c]">{t.expiredLabel}</span>
        ) : (
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <span
              data-testid="party-guest-label"
              className="text-xs font-medium text-[#a99e8c]"
            >
              {guestLabelDisplay}
            </span>
            <button
              data-testid="party-claim-btn"
              onClick={onExpand}
              className={`${PRIMARY_BTN} px-4 py-2 text-sm`}
            >
              {expanded ? t.cancelBtn : t.claimBtnSpot}
            </button>
          </div>
        )}
      </div>

      {/* Expandable claim form (unclaimed only) */}
      {expanded && !slot.claimed && !expired && (
        <ClaimForm
          token={token}
          claimId={slot.claimId}
          salonId={salonId}
          placeholderName={slot.guestLabel}
          t={t}
          partyConfig={partyConfig}
          onClaimed={handleClaimedHere}
        />
      )}

      {/* Personal Pass — shown after claiming in this session */}
      {slot.claimed && isMySlot && (
        <PersonalPass
          slot={slot}
          displayName={displayName}
          salonName={salonName}
          showAddToCalendar={partyConfig.showAddToCalendar}
          showArrivalNote={partyConfig.showArrivalNote}
          t={t}
        />
      )}

      {/* Post-claim controls — only shown on the slot claimed by this session */}
      {slot.claimed && isMySlot && !expired && (
        <div className="space-y-2 border-t border-[#f0e7d8] bg-[#fcfaf6] px-4 py-3">
          {/* Edit my details */}
          <button
            data-testid="party-edit-btn"
            onClick={() => { setEditOpen((v) => !v); setChangeOpen(false); }}
            className="flex w-full items-center gap-1.5 py-1 text-left text-sm font-medium text-[#6b6155] transition-colors hover:text-[#2c2620]"
          >
            <span aria-hidden>✏️</span>
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
              className="flex w-full items-center gap-1.5 py-1 text-left text-sm font-medium text-[#857a6c] transition-colors hover:text-[#2c2620]"
            >
              <span aria-hidden>💬</span>
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

/**
 * Pre-fill the claim name from the booking's placeholder, but only when
 * the organizer actually typed a real name. Generic "Guest 2" / "Khách 2"
 * placeholders stay empty so the guest types their own.
 */
function isGenericGuestLabel(label: string): boolean {
  return /^(guest|khách|khach)\s*\d+$/i.test(label.trim());
}

function ClaimForm({
  token,
  claimId,
  salonId,
  placeholderName,
  t,
  partyConfig,
  onClaimed,
}: {
  token: string;
  claimId: string;
  /** Salon UUID — returning-customer lookup for the guest's phone. */
  salonId: string;
  /** Booking-level guest label (organizer-typed name or "Guest N"). */
  placeholderName: string;
  t: PartyPageT;
  partyConfig: PartyLinkPageData["partyConfig"];
  onClaimed: (name: string) => void;
}) {
  // "Tap your name": when the organizer already named this guest, the
  // form opens with that name filled in — they just confirm.
  const [name, setName] = useState(
    isGenericGuestLabel(placeholderName) ? "" : placeholderName.trim(),
  );
  const [phone, setPhone] = useState("");
  const [reminder, setReminder] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Returning-guest one-tap: when THIS guest enters their phone and
  // they're a known customer, auto-fill their name (if still empty) so
  // they just confirm.
  const [recognizedName, setRecognizedName] = useState<string | null>(null);
  const recogTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (recogTimer.current) clearTimeout(recogTimer.current);
    const v = validateGuestPhone(phone.trim());
    if (!v.ok || !salonId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reactive reset when phone invalid
      setRecognizedName(null);
      return;
    }
    recogTimer.current = setTimeout(() => {
      void fetch(
        `/api/customer/${encodeURIComponent(v.digits)}?salon_id=${encodeURIComponent(salonId)}`,
      )
        .then((r) => r.json() as Promise<{ found: boolean; name?: string }>)
        .then((data) => {
          if (data.found && data.name) {
            setRecognizedName(data.name);
            setName((prev) => (prev.trim() ? prev : data.name!));
          } else {
            setRecognizedName(null);
          }
        })
        .catch(() => setRecognizedName(null));
    }, 400);
    return () => {
      if (recogTimer.current) clearTimeout(recogTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone, salonId]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const nameTrim = name.trim();
    const phoneTrim = phone.trim();

    if (!nameTrim) { setError(t.errNameRequired); return; }
    if (partyConfig.requirePhone && !phoneTrim) { setError(t.errPhoneRequired); return; }

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
      className="space-y-3.5 border-t border-[#f0e7d8] bg-[#fcfaf6] px-4 pb-4 pt-4"
    >
      <div>
        <p className="text-sm font-bold text-[#2c2620]">{t.claimFormTitle}</p>
        <p className="mt-0.5 text-xs text-[#857a6c]">{t.claimFormSubtext}</p>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-[#6b6155]">
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
          className={INPUT_CLASS}
        />
        {recognizedName ? (
          <p
            data-testid="party-claim-recognized"
            className="mt-1.5 text-xs font-medium text-[#9a7b29]"
          >
            {(t.recognizedGreeting ?? "Welcome back, {name}! 👋").replace(
              "{name}",
              recognizedName,
            )}
          </p>
        ) : null}
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-[#6b6155]">
          {t.formPhoneLabelReminder}
        </label>
        <input
          data-testid="party-claim-phone"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder={t.formPhonePlaceholder}
          required={partyConfig.requirePhone}
          className={INPUT_CLASS}
        />
        <p className="mt-1 text-xs text-[#a99e8c]">{t.formPhoneHint}</p>
        {partyConfig.showPrivacyNote && (
          <p className="mt-1.5 text-xs text-[#857a6c]">{t.phonePrivacyNote}</p>
        )}
      </div>

      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={reminder}
          onChange={(e) => setReminder(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-[#d9cdb9] text-[#9c7b43] focus:ring-[#bfa063]"
        />
        <span className="text-xs text-[#6b6155]">{t.formReminderLabel}</span>
      </label>

      {error && (
        <p data-testid="party-claim-error" className="text-xs font-medium text-red-600">{error}</p>
      )}

      <button
        data-testid="party-claim-submit"
        type="submit"
        disabled={isPending}
        className={`${PRIMARY_BTN} w-full py-3 text-sm`}
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
      <p className="flex items-center gap-1.5 py-1 text-xs font-medium text-emerald-600">
        <CheckCircle className="h-4 w-4" /> {t.editDetailsSuccess}
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2.5 pt-1">
      <p className="text-xs font-semibold text-[#6b6155]">{t.editDetailsHeading}</p>

      <div>
        <label className="mb-1 block text-xs font-medium text-[#6b6155]">
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
          className={INPUT_CLASS}
        />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-[#6b6155]">
          {t.formPhoneLabel}
        </label>
        <input
          data-testid="party-edit-phone"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder={t.formPhonePlaceholder}
          required
          className={INPUT_CLASS}
        />
      </div>

      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={reminder}
          onChange={(e) => setReminder(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-[#d9cdb9] text-[#9c7b43] focus:ring-[#bfa063]"
        />
        <span className="text-xs text-[#6b6155]">{t.formReminderLabel}</span>
      </label>

      {error && <p className="text-xs font-medium text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button
          data-testid="party-edit-submit"
          type="submit"
          disabled={isPending}
          className={`${PRIMARY_BTN} flex-1 py-2.5 text-sm`}
        >
          {isPending ? t.editDetailsSaving : t.editDetailsSave}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={`${SECONDARY_BTN} px-3 py-2.5`}
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
        <p data-testid="party-change-req-success" className="flex items-center gap-1.5 text-sm font-medium text-emerald-600">
          <CheckCircle className="h-4 w-4" /> {t.changeRequestSuccess}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-[#857a6c] underline"
        >
          {t.changeRequestClose}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2.5 pt-1">
      <p className="text-xs text-[#857a6c]">{t.changeRequestHint}</p>

      {/* Request type selection */}
      <div className="flex flex-wrap gap-2">
        {CHANGE_REQUEST_TYPES.map(({ type, labelKey }) => (
          <button
            key={type}
            type="button"
            onClick={() => setSelectedType(type)}
            className={`rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
              selectedType === type
                ? "border-[#2c2620] bg-[#2c2620] text-white"
                : "border-[#d9cdb9] bg-white text-[#6b6155] hover:border-[#bfa063]"
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
          className={`${INPUT_CLASS} resize-none`}
        />
      )}

      {error && <p className="text-xs font-medium text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button
          data-testid="party-change-req-submit"
          type="submit"
          disabled={isPending || !selectedType}
          className={`${PRIMARY_BTN} flex-1 py-2.5 text-sm`}
        >
          {isPending ? t.changeRequestSubmitting : t.changeRequestSubmit}
        </button>
        <button
          type="button"
          onClick={onClose}
          className={`${SECONDARY_BTN} px-3 py-2.5`}
        >
          {t.editDetailsCancel}
        </button>
      </div>
    </form>
  );
}
