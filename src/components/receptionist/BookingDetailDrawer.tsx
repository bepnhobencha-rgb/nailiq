"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";

import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import type { UserMessages } from "@/shared/i18n/user";
import { cn } from "@/shared/lib/cn";
import { displayCustomerName } from "@/shared/lib/customerDisplayName";
import {
  canEditBooking as roleAllowsEditBooking,
  type SalonMemberRole,
} from "@/shared/lib/salonMemberRole";
import { type Currency } from "@/shared/lib/currencyFormat";
import type { BookingStatus, SalonDashboardBooking } from "@/shared/types";

import { EditBookingForm, type EditBookingFormBooking } from "./EditBookingForm";
import { DepositLinkModal } from "./DepositLinkModal";
import { requestDepositLink } from "@/shared/dashboard/receptionistActions";
import { sendSaveCardLink } from "@/shared/dashboard/sendSaveCardLinkAction";
import { renameBookingClient } from "@/shared/dashboard/renameClientAction";
import { updateBookingNote } from "@/shared/dashboard/editBookingNoteAction";
import type { BookingCustomerContext } from "@/shared/dashboard/loadBookingCustomerContextAction";
import {
  loadGroupMembersAction,
  type GroupMember,
} from "@/shared/dashboard/loadGroupMembersAction";

function depositErrorLabel(code: string, lang: "en" | "vi"): string {
  if (code.startsWith("risk "))
    return lang === "en"
      ? "Customer isn't high-risk enough for a deposit."
      : "Khách chưa đủ mức rủi ro để cần cọc.";
  if (code.includes("disabled"))
    return lang === "en"
      ? "Deposits aren't enabled for this salon."
      : "Tính năng cọc chưa bật cho tiệm này.";
  if (code === "unauthorized" || code === "salon_mismatch")
    return lang === "en" ? "Not allowed." : "Không có quyền.";
  if (code === "invalid_booking")
    return lang === "en" ? "Invalid booking." : "Lịch không hợp lệ.";
  return lang === "en"
    ? "Couldn't create the deposit link — try again."
    : "Không tạo được link cọc, thử lại.";
}

/** Self-contained desk action: create a Square deposit link for ANY booking the
 *  receptionist chooses (manual → bypasses the no-show-risk gate), then show it
 *  as a QR AND offer to text it to the customer. Kept here so the drawer stays
 *  the single owner of the deposit UI. */
/** Desk "save a card to hold the spot" — texts the customer a one-tap
 *  card-capture link (charge only on no-show). The wow no-show flow: no
 *  upfront payment for the customer, automatic protection for the salon. */
function SaveCardButton({
  slug,
  bookingId,
  disabled,
  offlineHint,
  language,
}: {
  slug: string;
  bookingId: string;
  disabled?: boolean;
  offlineHint?: string;
  language: "en" | "vi";
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"sent" | "error" | null>(null);

  async function onPress() {
    setBusy(true);
    setResult(null);
    try {
      const r = await sendSaveCardLink(slug, { bookingId, sendSms: true, language });
      setResult(r.ok && r.smsSent ? "sent" : "error");
    } catch {
      setResult("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        loading={busy}
        disabled={disabled}
        title={disabled ? offlineHint : undefined}
        data-testid="drawer-save-card-link"
        className="mt-2 w-full sm:w-full"
        onClick={() => void onPress()}
      >
        {language === "en" ? "💳 Text save-card link" : "💳 Gửi link lưu thẻ"}
      </Button>
      {result === "sent" ? (
        <p className="text-xs font-semibold text-nq-success" role="status">
          {language === "en"
            ? "✓ Save-card link sent by SMS"
            : "✓ Đã gửi link lưu thẻ qua SMS"}
        </p>
      ) : null}
      {result === "error" ? (
        <p className="text-xs font-semibold text-nq-error" role="status">
          {language === "en"
            ? "Couldn't send the link — check the phone number."
            : "Không gửi được link — kiểm tra số điện thoại."}
        </p>
      ) : null}
    </>
  );
}

function DepositButton({
  slug,
  salonId,
  bookingId,
  disabled,
  offlineHint,
  language,
}: {
  slug: string;
  salonId: string;
  bookingId: string;
  disabled?: boolean;
  offlineHint?: string;
  language: "en" | "vi";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<{ url: string; amountCents: number } | null>(null);
  const label = language === "en" ? "💰 Request deposit" : "💰 Tạo link cọc";

  async function onPress() {
    setBusy(true);
    setError(null);
    try {
      // manual: a human at the desk decided a deposit is warranted → skip the
      // server's no-show-risk gate. hold:false → request a deposit without
      // flipping the booking to pending (the "hold / pay-to-confirm" variant
      // was removed: unused at the desk + its auto-cancel cron isn't wired,
      // so it left bookings stuck "pending"; see no-show card-on-file plan).
      const r = await requestDepositLink(slug, { salonId, bookingId, manual: true, hold: false, language });
      if (r.ok) setModal({ url: r.url, amountCents: r.amountCents });
      else setError(depositErrorLabel(r.error, language));
    } catch {
      setError(depositErrorLabel("server_error", language));
    } finally {
      setBusy(false);
    }
  }

  // Text the (idempotent) link to the customer. Returns ok only when Twilio
  // actually accepted the message so the modal can show a truthful result.
  async function onSendSms(): Promise<boolean> {
    try {
      const r = await requestDepositLink(slug, {
        salonId,
        bookingId,
        manual: true,
        hold: false,
        sendSms: true,
        language,
      });
      return r.ok && r.smsSent === true;
    } catch {
      return false;
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        loading={busy}
        disabled={disabled}
        title={disabled ? offlineHint : undefined}
        data-testid="drawer-deposit-link"
        className="w-full sm:w-full"
        onClick={() => void onPress()}
      >
        {label}
      </Button>
      {error ? (
        <p className="text-xs font-semibold text-nq-error" role="status">
          {error}
        </p>
      ) : null}
      {modal ? (
        <DepositLinkModal
          open
          onClose={() => setModal(null)}
          url={modal.url}
          amountCents={modal.amountCents}
          language={language}
          onSendSms={onSendSms}
        />
      ) : null}
    </>
  );
}

/**
 * Booking status → Badge variant, per the locked status palette in
 * `COLOR_TOKENS.md` §5. Mirrors the timeline-block hues (`BookingBlock`)
 * so a booking's status reads the same in the grid and in this detail
 * panel (P2: color-coding consistent across both surfaces). Badge has no
 * orange/slate variant, so `waiting` borrows the warning (amber) family
 * and `cancelled` the neutral (slate-ish) family — safe here because the
 * drawer shows exactly one booking's status, always paired with its text
 * label (`COLOR_TOKENS.md` §7: never hue-only encoding).
 */
function statusBadgeVariant(status: BookingStatus): BadgeVariant {
  switch (status) {
    case "confirmed":
      return "info"; // cool blue — committed timehold
    case "in_progress":
      return "success"; // green — active chair time
    case "pending":
    case "waiting":
      return "warning"; // amber — needs attention / motion
    case "completed":
    case "cancelled":
      return "neutral"; // low-arousal muted / slate
  }
}

/** Localized salon-role label for the "Booked by … · <role>" creator line. */
function roleLabel(role: string, lang: "en" | "vi"): string {
  const map: Record<string, [string, string]> = {
    owner: ["Owner", "Chủ tiệm"],
    admin: ["Manager", "Quản lý"],
    senior: ["Senior", "Thợ chính"],
    receptionist: ["Receptionist", "Lễ tân"],
    nail_tech: ["Technician", "Thợ"],
  };
  const hit = map[role];
  return hit ? (lang === "vi" ? hit[1] : hit[0]) : role;
}

/** Render a return-cadence in human terms ("every ~4 weeks" / "mỗi ~4 tuần"). */
function cadenceLabel(days: number, lang: "en" | "vi"): string {
  if (days >= 12) {
    const weeks = Math.round(days / 7);
    return lang === "vi" ? `mỗi ~${weeks} tuần` : `every ~${weeks} weeks`;
  }
  return lang === "vi" ? `mỗi ~${days} ngày` : `every ~${days} days`;
}

/** Inline "actual final price" editor for variable-priced bookings. Self-contained
 *  so the drawer stays simple. Parses dollars→cents (×1 for VND, ×100 otherwise). */
function FinalPriceEditor({
  action,
}: {
  action: NonNullable<BookingDetailDrawerProps["finalPriceAction"]>;
}) {
  const factor = action.currency === "VND" ? 1 : 100;
  const initial =
    action.currentCents != null ? String(action.currentCents / factor) : "";
  const [draft, setDraft] = useState(initial);
  const [saved, setSaved] = useState(false);
  // Re-sync when a different booking opens (currentCents changes).
  useEffect(() => {
    setDraft(action.currentCents != null ? String(action.currentCents / factor) : "");
    setSaved(false);
  }, [action.currentCents, factor]);

  const cents = Math.round(parseFloat(draft) * factor);
  const valid = draft.trim() !== "" && Number.isFinite(cents) && cents >= 0;

  return (
    <div className="mt-2 rounded-lg border border-nq-primary/25 bg-nq-primary/5 px-2.5 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-primary">
        {action.fieldLabel}
      </p>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="number"
          inputMode="decimal"
          min={0}
          value={draft}
          disabled={action.busy}
          onChange={(e) => {
            setDraft(e.target.value);
            setSaved(false);
          }}
          className="w-24 rounded-lg border border-nq-border/40 bg-nq-surface/70 px-2 py-1 text-sm tabular-nums text-nq-foreground focus:border-nq-primary/50 focus:outline-none focus:ring-1 focus:ring-nq-primary/30 disabled:opacity-50"
          aria-label={action.fieldLabel}
        />
        <button
          type="button"
          disabled={action.busy || !valid}
          onClick={async () => {
            await action.onSave(cents);
            setSaved(true);
            setTimeout(() => setSaved(false), 2500);
          }}
          className="rounded-lg border border-nq-primary/40 bg-nq-primary/10 px-2.5 py-1 text-xs font-semibold text-nq-primary transition hover:bg-nq-primary/15 disabled:opacity-50"
        >
          {action.busy ? "…" : action.saveLabel}
        </button>
        {saved ? <span className="text-xs text-nq-success">{action.savedLabel}</span> : null}
      </div>
    </div>
  );
}

/** Precomputed presentation values built by `ReceptionistCenter` so this leaf stays dumb. */
export type BookingDetailDrawerModel = {
  clientName: string;
  /** E.164-ish or digits for `tel:` */
  telHref: string | null;
  /** US/CA style display for copy + tel label */
  phoneDisplay: string | null;
  /** P0.8: privacy-masked phone display, e.g. "***-***-7890".
   * Rendered by default; revealing swaps in `phoneDisplay`. Computed
   * by the caller so this leaf stays dumb about formatting. */
  phoneMasked: string | null;
  clientNotes: string | null;
  serviceName: string;
  staffName: string;
  /** Raw booking status — drives the color-coded status Badge (P2:
   * status color must read consistently across the timeline + this
   * panel). The localized text lives in `statusLabel`. */
  status: BookingStatus;
  statusLabel: string;
  sourceLabel: string;
  /** "Book ở đâu" — friendly label for the granular origin channel
   * (🌐 Online / 🧑‍💼 Front desk / 🚶 Walk-in / 🔗 Wix / ⬛ Square / 📞 Voice).
   * Null for legacy rows → fall back to `sourceLabel`. */
  channelLabel: string | null;
  /** "Khi nào book" — when the booking was created (salon tz, datetime).
   * Null when `created_at` is missing. */
  bookedAtLine: string | null;
  /** When true, render a "Khách yêu cầu thợ này" line under the
   * source. Drives operator awareness without forcing them to scan
   * the staff_request_note (which may be empty for online bookings). */
  staffRequestedByClient: boolean;
  /** One line: localized date + wall-clock range; reflects total span (main + add-on). */
  scheduleLine: string;
  /** Combined main + add-on duration, formatted via `durationMinutes` copy. */
  durationLine: string;
  /** Combined main + add-on price; null only when both prices are missing. */
  priceLine: string | null;
  /** Add-on service display name; null when the booking has no add-on. */
  addonServiceName: string | null;
  /** Add-on duration line (e.g. "30 minutes"); null when no add-on. */
  addonDurationLine: string | null;
  /** All add-ons on the booking (multi-add-on). Empty when none.
   *  `timingLabel` = short "during"/"after · +Xm" hint (null for legacy single). */
  addons: { name: string; price_cents: number | null; timingLabel: string | null }[];
  /** Smart verification method recorded on booking. */
  verificationMethod: string | null;
  /** Non-null when SMS confirmation failed — show warning badge. */
  smsFailedAt: string | null;
  /** No-show risk score 0-100. */
  noShowRiskScore: number | null;
  /** Client's lifetime no-show count (cross-salon). 0 = clean. */
  noShowHistoryCount: number;
  /** Deposit lifecycle status (e.g. 'paid'); null when no deposit on this booking. */
  depositStatus: string | null;
  /** Formatted deposit already paid via Square (e.g. "$17.00"); null when none. */
  depositPaidLine: string | null;
  /** Formatted balance still to charge on the POS (price − deposit); null when no deposit. */
  remainingLine: string | null;
  /** Formatted deposit owed but NOT yet paid (deposit_status='required') — the
   *  slot is "Chờ cọc", shown as an amber badge; null when none. */
  depositAwaitingLine: string | null;
  /** Square deposits enabled for this salon — gates the desk "request deposit" action. */
  depositsEnabled: boolean;
  /** No-show card-on-file saved for this booking (charge only on no-show).
   *  Surfaces the existing protection at the desk as a green badge. */
  cardOnFile: boolean;
  /** Booking was flagged "needs a no-show card" at creation (any path) but has
   *  none yet → drives the "⚠️ needs card" badge + gates the send-link button. */
  noshowCardRequired: boolean;
  /** Formatted no-show fee that would be charged if they no-show (e.g. "$25.00");
   *  null when no fee/card is set. */
  noshowFeeLine: string | null;
  /** Dashboard language — drives the deposit SMS copy + the deposit modal/button text. */
  language: "en" | "vi";
  /** Group/party this booking belongs to (null = solo booking). Drives the
   *  "who's going with whom" party section, lazily loaded when the drawer opens. */
  groupId: string | null;
  /** Party asked to be seated together (couple / 💕). */
  seatTogether: boolean;
};

export interface BookingDetailDrawerProps {
  open: boolean;
  model: BookingDetailDrawerModel | null;
  /** Salon slug — used to lazily load the party composition for group bookings. */
  slug?: string;
  onClose: () => void;
  copy: {
    title: string;
    closeAria: string;
    /** Localized label for a redacted/removed customer ("[removed]" in DB). */
    removedGuest: string;
    sectionGuest: string;
    sectionService: string;
    sectionStaff: string;
    sectionWhen: string;
    sectionStatus: string;
    sectionNotes: string;
    sectionPrice: string;
    sectionAddon: string;
    noNotes: string;
    callGuest: (formattedDisplay: string) => string;
    /** P0.8: short "Call" label (no phone embedded) for the masked
     * phone block — full number only appears in the masked/revealed
     * display above. */
    callGuestShort: string;
    /** P0.8 phone-privacy labels. */
    phoneSection: string;
    revealPhone: string;
    hidePhone: string;
    nonePrice: string;
    /** "❤️ Khách yêu cầu thợ này" line under the source label. */
    staffRequestedByClient: string;
    /** Party/group composition section ("who's going with whom"). */
    groupSectionTitle: (n: number) => string;
    groupOrganizedBy: (name: string) => string;
    groupOrganizerBadge: string;
    groupSeatTogether: string;
  };
  /** Lazy "customer launchpad" context (creator / allergies / return cadence),
   *  loaded by the parent when the drawer opens. `undefined` = still loading,
   *  `null` = unavailable (no phone / error). */
  customerContext?: BookingCustomerContext | null;
  /** True while {@link customerContext} is being fetched. */
  customerContextLoading?: boolean;
  /** Open the full Customer 360 profile + history for this guest. Present only
   *  when the booking has a phone to look up. */
  onViewProfile?: () => void;
  /** One-tap "book the next visit" — opens the desk form prefilled with this
   *  customer at their usual rhythm. Present only when a phone exists. */
  onRebookNext?: () => void;
  /** Caller's `salon_members.role` — gates Edit (Cancel is gated upstream). */
  viewerRole: SalonMemberRole;
  /**
   * Realtime offline guard — when true, all footer mutation buttons
   * (Edit, primary, cancel) are disabled and an inline offline hint
   * is rendered above the row. Mutation guard for `ConnectionBanner`
   * state — prevents writes against stale data when the realtime
   * channel is closed/erroring.
   */
  isOffline?: boolean;
  /** Localized "Offline — editing unavailable" hint. */
  offlineEditDisabledHint?: string;
  /** Primary footer CTA (start or mark complete), when applicable. */
  primaryAction?: {
    label: string;
    busy: boolean;
    onPress: () => void | Promise<void>;
  };
  /** Destructive cancel; parent should confirm before calling onPress. */
  cancelAction?: {
    label: string;
    busy: boolean;
    onPress: () => void | Promise<void>;
  };
  /** Restore a cancelled booking back to confirmed (owner / senior only). */
  restoreAction?: {
    label: string;
    busy: boolean;
    onPress: () => void | Promise<void>;
  };
  /** Decline a Wix-origin pending booking (→ declined on Wix). Owner / senior only. */
  declineAction?: {
    label: string;
    busy: boolean;
    onPress: () => void | Promise<void>;
  };
  /** Mark a past confirmed/in-progress booking as a no-show. Owner / senior only. */
  noShowAction?: {
    label: string;
    busy: boolean;
    onPress: () => void | Promise<void>;
  };
  /** Enter the ACTUAL final price for a variable-priced ('from'/'range') booking.
   *  Present only when the service is variable + viewer may edit. Owner/senior. */
  finalPriceAction?: {
    fieldLabel: string; // "Giá thực tế" / "Final price"
    saveLabel: string; // "Lưu" / "Save"
    savedLabel: string; // "✓ Đã lưu"
    busy: boolean;
    currency: Currency;
    currentCents: number | null;
    onSave: (priceCents: number) => void | Promise<void>;
  };
  /** Inline edit (pending | confirmed); optional so presentational tests can omit. */
  deskEdit?: {
    slug: string;
    salonId: string;
    booking: EditBookingFormBooking;
    staff: { id: string; name: string }[];
    services: {
      id: string;
      name: string;
      price_cents: number;
      price_type: string;
      price_max_cents: number | null;
      duration_minutes: number;
      buffer_minutes: number;
    }[];
    /** Per-staff service whitelist for the salon. `null` = no rows → all-capable fallback. */
    capabilityRows: { staff_id: string; service_id: string }[] | null;
    dayYmd: string;
    timezone: string;
    rcMessages: UserMessages["receptionist"];
    /** P0.2 — currency for the inline edit form's price preview. */
    currency: import("@/shared/lib/currencyFormat").Currency;
    onBookingUpdated: (updated: SalonDashboardBooking) => void | Promise<void>;
  };
}

export function BookingDetailDrawer({
  open,
  model,
  slug,
  onClose,
  copy,
  customerContext,
  customerContextLoading = false,
  onViewProfile,
  onRebookNext,
  viewerRole,
  isOffline = false,
  offlineEditDisabledHint,
  primaryAction,
  cancelAction,
  restoreAction,
  declineAction,
  noShowAction,
  finalPriceAction,
  deskEdit,
}: BookingDetailDrawerProps) {
  const [editMode, setEditMode] = useState(false);
  // Inline customer-name fix (fastest path for the desk — no page navigation).
  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [nameErr, setNameErr] = useState(false);
  const [nameSaving, startNameSave] = useTransition();
  // Inline appointment-note edit (booking-scoped; undefined override = unchanged).
  const [noteEditing, setNoteEditing] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteOverride, setNoteOverride] = useState<string | null | undefined>(undefined);
  const [noteErr, setNoteErr] = useState(false);
  const [noteSaving, startNoteSave] = useTransition();
  const [portalEl, setPortalEl] = useState<HTMLElement | null>(null);
  // P0.8 — phone is masked by default; receptionist must explicitly
  // tap "Show number" to reveal. Resets whenever the drawer closes or
  // switches to a different booking, so an unrelated open never leaks
  // the previous customer's full digits.
  const [phoneRevealed, setPhoneRevealed] = useState(false);
  // Party composition ("who's going with whom"), lazily loaded for group bookings.
  const [party, setParty] = useState<{
    members: GroupMember[];
    organizerName: string | null;
  } | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- portal target is only available client-side
    setPortalEl(document.body);
  }, []);

  useEffect(() => {
    const gid = model?.groupId;
    if (!open || !gid || !slug) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale party when the drawer closes / rebinds to a solo booking
      setParty(null);
      return;
    }
    let alive = true;
    void loadGroupMembersAction(slug, gid)
      .then((r) => {
        if (!alive) return;
        setParty(
          r.ok ? { members: r.members, organizerName: r.organizerName } : null,
        );
      })
      .catch(() => {
        if (alive) setParty(null);
      });
    return () => {
      alive = false;
    };
  }, [open, model?.groupId, slug]);

  const handleClose = useCallback(() => {
    setEditMode(false);
    onClose();
  }, [onClose]);

  /* eslint-disable react-hooks/set-state-in-effect -- ARCHITECTURE_LOCK: exit edit mode + reset phone reveal when drawer closes */
  useEffect(() => {
    if (!open) {
      setEditMode(false);
      setPhoneRevealed(false);
    }
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- exit edit mode + re-mask when drawer rebinds to a different booking
    setEditMode(false);
    setPhoneRevealed(false);
    setNameEditing(false);
    setNameOverride(null);
    setNameErr(false);
    setNoteEditing(false);
    setNoteOverride(undefined);
    setNoteErr(false);
  }, [deskEdit?.booking.id]);

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, handleClose]);

  // Edit visibility = booking is in an editable status AND viewer's role
  // allows it. `roleAllowsEditBooking` is the role-side gate (owner/senior
  // yes, nail_tech no); the status check is the booking-state gate.
  // P1.12 — `in_progress` bookings are now editable too: receptionists
  // sometimes need to add a service / shift staff after the chair is
  // already in use. Cancel from in_progress was already allowed
  // (`drawerCancelAction`), so this just unifies the surface.
  const canEditBooking =
    deskEdit !== undefined &&
    roleAllowsEditBooking(viewerRole) &&
    (deskEdit.booking.status === "pending" ||
      deskEdit.booking.status === "confirmed" ||
      deskEdit.booking.status === "in_progress");

  // A name typo can need fixing on a booking of ANY status (incl. completed),
  // so gate the rename on the front-desk role only, not the editable statuses.
  const canEditName = deskEdit !== undefined && roleAllowsEditBooking(viewerRole);

  const saveName = useCallback(() => {
    const next = nameDraft.trim();
    const bId = deskEdit?.booking.id;
    if (!bId || !slug || next.length === 0) {
      setNameErr(true);
      return;
    }
    const bookingId: string = bId;
    const slugStr: string = slug;
    setNameErr(false);
    startNameSave(async () => {
      const r = await renameBookingClient(slugStr, { bookingId, name: next });
      if (r.ok && r.name) {
        setNameOverride(r.name);
        setNameEditing(false);
        if (deskEdit) void deskEdit.onBookingUpdated(deskEdit.booking);
      } else {
        setNameErr(true);
      }
    });
  }, [nameDraft, deskEdit, slug]);

  const saveNote = useCallback(() => {
    const bId = deskEdit?.booking.id;
    if (!bId || !slug) {
      setNoteErr(true);
      return;
    }
    const bookingId: string = bId;
    const slugStr: string = slug;
    const next = noteDraft; // allow empty → clears the note
    setNoteErr(false);
    startNoteSave(async () => {
      const r = await updateBookingNote(slugStr, { bookingId, note: next });
      if (r.ok) {
        setNoteOverride(r.note ?? null);
        setNoteEditing(false);
        if (deskEdit) void deskEdit.onBookingUpdated(deskEdit.booking);
      } else {
        setNoteErr(true);
      }
    });
  }, [noteDraft, deskEdit, slug]);

  const showFooter =
    (deskEdit !== undefined && editMode) ||
    primaryAction !== undefined ||
    cancelAction !== undefined ||
    declineAction !== undefined ||
    noShowAction !== undefined ||
    restoreAction !== undefined ||
    (canEditBooking && !editMode);

  const sheet = (
    <div
      className={cn(
        "fixed inset-0 z-[60] w-full md:inset-y-0 md:left-auto md:right-0 md:h-[100dvh] md:w-[min(480px,90vw)]",
        open ? "pointer-events-auto" : "pointer-events-none",
      )}
      aria-hidden={!open}
      inert={!open}
    >
      <button
        type="button"
        aria-label={copy.closeAria}
        tabIndex={open ? 0 : -1}
        className={cn(
          "absolute inset-0 bg-nq-bg/70 backdrop-blur-[2px]",
          "motion-safe:transition-opacity motion-safe:duration-[var(--duration-nq-fast,180ms)]",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={handleClose}
      />

      <div
        data-testid="booking-detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nq-booking-detail-title"
        className={cn(
          "relative ml-auto flex h-full min-h-[40dvh] min-w-0 max-w-full flex-col overflow-hidden bg-nq-surface shadow-nq-card",
          "motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-[var(--ease-nq-out,cubic-bezier(0.22,1,0.36,1))]",
          open ? "translate-x-0" : "translate-x-full",
          "pt-[max(0.5rem,env(safe-area-inset-top))]",
        )}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-nq-muted/20 px-4 py-3">
          <h2
            id="nq-booking-detail-title"
            className="truncate text-lg font-semibold text-nq-foreground"
          >
            {copy.title}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className={cn(
              "min-h-10 min-w-10 shrink-0 rounded-lg border border-nq-muted/40 text-sm font-medium text-nq-muted",
              "hover:border-nq-muted hover:text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/40",
            )}
            aria-label={copy.closeAria}
          >
            ✕
          </button>
        </header>

        {model ? (
          <>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden px-4 py-4 text-sm">
              <section className="space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                  {copy.sectionGuest}
                </p>
                {nameEditing ? (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <input
                        autoFocus
                        data-testid="drawer-name-input"
                        value={nameDraft}
                        disabled={nameSaving}
                        onChange={(e) => {
                          setNameDraft(e.target.value);
                          setNameErr(false);
                        }}
                        onKeyDown={(e) => {
                          if (e.nativeEvent.isComposing) return;
                          if (e.key === "Enter") saveName();
                          if (e.key === "Escape") setNameEditing(false);
                        }}
                        className={cn(
                          "min-w-0 flex-1 rounded-lg border bg-nq-bg px-2 py-1 text-base font-semibold text-nq-foreground focus:outline-none focus:border-nq-primary/60",
                          nameErr ? "border-nq-error/70" : "border-nq-border/50",
                        )}
                      />
                      <button
                        type="button"
                        data-testid="drawer-name-save"
                        disabled={nameSaving}
                        onClick={saveName}
                        className="rounded-lg bg-nq-primary px-2.5 py-1 text-xs font-semibold text-black disabled:opacity-50"
                      >
                        {nameSaving
                          ? (model.language === "vi" ? "Đang lưu…" : "Saving…")
                          : (model.language === "vi" ? "Lưu" : "Save")}
                      </button>
                      <button
                        type="button"
                        disabled={nameSaving}
                        onClick={() => { setNameEditing(false); setNameErr(false); }}
                        className="text-xs text-nq-muted underline-offset-2 hover:underline"
                      >
                        {model.language === "vi" ? "Huỷ" : "Cancel"}
                      </button>
                    </div>
                    {nameErr ? (
                      <p className="text-xs text-nq-error" role="alert">
                        {model.language === "vi" ? "Tên không hợp lệ hoặc lưu lỗi." : "Invalid name or save failed."}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <p className="text-base font-semibold text-nq-foreground">{displayCustomerName(nameOverride ?? model.clientName, copy.removedGuest)}</p>
                    {canEditName ? (
                      <button
                        type="button"
                        data-testid="drawer-name-edit"
                        aria-label={model.language === "vi" ? "Sửa tên khách" : "Edit customer name"}
                        title={model.language === "vi" ? "Sửa tên" : "Edit name"}
                        onClick={() => {
                          setNameDraft(nameOverride ?? model.clientName ?? "");
                          setNameErr(false);
                          setNameEditing(true);
                        }}
                        className="text-nq-muted hover:text-nq-foreground"
                      >
                        ✏️
                      </button>
                    ) : null}
                  </div>
                )}
                {/* Channel (e.g. 🧑‍💼 Lễ tân đặt tại quầy) is shown once, in the
                    "Đặt lúc · <channel>" line of the schedule section — no longer
                    duplicated here under the guest name. */}
                {/* "Ai đặt hẹn này" — creator of a manual booking (or self-book). */}
                {customerContext?.creatorName ? (
                  <p className="text-xs text-nq-muted" data-testid="booking-drawer-created-by">
                    {model.language === "vi" ? "Đặt bởi " : "Booked by "}
                    <span className="font-medium text-nq-foreground">
                      {customerContext.creatorName}
                    </span>
                    {customerContext.creatorRole ? (
                      <> · {roleLabel(customerContext.creatorRole, model.language)}</>
                    ) : null}
                  </p>
                ) : customerContext?.isSelfBooked ? (
                  <p className="text-xs text-nq-muted" data-testid="booking-drawer-created-by">
                    {model.language === "vi" ? "Khách tự đặt" : "Self-booked by guest"}
                  </p>
                ) : customerContext?.creatorRole ? (
                  <p className="text-xs text-nq-muted" data-testid="booking-drawer-created-by">
                    {model.language === "vi" ? "Đặt bởi " : "Booked by "}
                    {roleLabel(customerContext.creatorRole, model.language)}
                  </p>
                ) : null}
                {/* ⚠️ Allergy — safety-critical, surfaced at the top of the card. */}
                {customerContext?.allergies ? (
                  <p
                    className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg border border-red-400/40 bg-red-400/10 px-2.5 py-1 text-[13px] font-medium text-red-300"
                    data-testid="booking-drawer-allergy"
                  >
                    <span aria-hidden>⚠️</span>
                    <span>
                      {model.language === "vi" ? "Dị ứng: " : "Allergy: "}
                      {customerContext.allergies}
                    </span>
                  </p>
                ) : null}
                {model.staffRequestedByClient ? (
                  <p
                    className="inline-flex items-center gap-1.5 text-nq-foreground"
                    data-testid="booking-drawer-staff-requested"
                  >
                    <span aria-hidden>❤️</span>
                    <span>{copy.staffRequestedByClient}</span>
                  </p>
                ) : null}
                {model.telHref !== null ? (
                  // P0.8 — phone privacy: masked-by-default display +
                  // explicit reveal toggle. The `tel:` link always
                  // dials the real number regardless of reveal state,
                  // so the receptionist can hit Call without showing
                  // the digits to anyone behind them.
                  <div
                    className="mt-2 space-y-1.5"
                    data-testid="booking-drawer-phone-block"
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                      {copy.phoneSection}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        data-testid="booking-drawer-phone-display"
                        data-phone-revealed={phoneRevealed ? "true" : "false"}
                        className="font-mono text-sm tabular-nums text-nq-foreground"
                      >
                        {phoneRevealed
                          ? model.phoneDisplay ?? ""
                          : model.phoneMasked ?? ""}
                      </span>
                      <button
                        type="button"
                        data-testid="booking-drawer-phone-toggle"
                        onClick={() => setPhoneRevealed((v) => !v)}
                        className="inline-flex min-h-8 items-center rounded-md border border-nq-muted/40 px-2 py-1 text-xs font-medium text-nq-muted hover:border-nq-muted hover:text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/40"
                      >
                        {phoneRevealed ? copy.hidePhone : copy.revealPhone}
                      </button>
                    </div>
                    <a
                      data-testid="booking-call-link"
                      href={`tel:${model.telHref}`}
                      className={cn(
                        "mt-1 inline-flex min-h-11 items-center justify-center rounded-lg border border-nq-primary/45 bg-nq-primary/12 px-4 text-sm font-semibold text-nq-primary",
                      )}
                    >
                      {copy.callGuestShort}
                    </a>
                  </div>
                ) : null}
              </section>

            {/* ── Customer launchpad — history + return rhythm + one-tap rebook.
                Only rendered when a phone exists (onViewProfile/onRebookNext set). */}
            {(onViewProfile || onRebookNext) ? (
              <section
                className="space-y-2 border-t border-nq-muted/15 pt-4"
                data-testid="booking-drawer-launchpad"
              >
                {customerContextLoading && customerContext === undefined ? (
                  <p className="text-xs text-nq-muted">
                    {model.language === "vi" ? "Đang tải hồ sơ khách…" : "Loading customer…"}
                  </p>
                ) : null}
                {customerContext?.cadenceDays != null ? (
                  <p className="text-sm text-nq-foreground" data-testid="booking-drawer-cadence">
                    <span aria-hidden>⏱ </span>
                    {model.language === "vi" ? "Thường quay lại " : "Usually returns "}
                    <span className="font-semibold">
                      {cadenceLabel(customerContext.cadenceDays, model.language)}
                    </span>
                    {customerContext.visitCount > 0 ? (
                      <span className="text-nq-muted">
                        {model.language === "vi"
                          ? ` · ${customerContext.visitCount} lần ghé`
                          : ` · ${customerContext.visitCount} visits`}
                      </span>
                    ) : null}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {onViewProfile ? (
                    <button
                      type="button"
                      onClick={onViewProfile}
                      data-testid="booking-drawer-view-profile"
                      className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-nq-muted/40 px-3 text-sm font-medium text-nq-foreground transition hover:border-nq-muted hover:bg-nq-muted/10"
                    >
                      <span aria-hidden>👤</span>
                      {model.language === "vi" ? "Hồ sơ & lịch sử" : "Profile & history"}
                      <span aria-hidden>→</span>
                    </button>
                  ) : null}
                  {onRebookNext ? (
                    <button
                      type="button"
                      onClick={onRebookNext}
                      data-testid="booking-drawer-rebook-next"
                      className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-nq-primary/45 bg-nq-primary/12 px-3 text-sm font-semibold text-nq-primary transition hover:bg-nq-primary/20"
                    >
                      <span aria-hidden>📅</span>
                      {model.language === "vi" ? "Đặt hẹn kế tiếp" : "Book next visit"}
                    </button>
                  ) : null}
                </div>
              </section>
            ) : null}

            <section className="space-y-1 border-t border-nq-muted/15 pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                {copy.sectionService}
              </p>
              <p className="font-medium text-nq-foreground">{model.serviceName}</p>
              <p className="text-nq-muted">{model.durationLine}</p>
              {model.priceLine ? (
                <p className="mt-2 text-xs text-nq-muted">
                  <span className="font-semibold uppercase tracking-wide">{copy.sectionPrice}</span>
                  {": "}
                  <span className="font-medium text-nq-foreground">{model.priceLine}</span>
                </p>
              ) : (
                <p className="mt-2 text-xs text-nq-muted">
                  <span className="font-semibold uppercase tracking-wide">{copy.sectionPrice}</span>
                  {": "}
                  {copy.nonePrice}
                </p>
              )}
              {model.remainingLine ? (
                <div className="mt-2 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs" data-testid="drawer-deposit-summary">
                  <p className="flex items-center justify-between text-nq-foreground/90">
                    <span>💰 Đã cọc</span>
                    <span className="font-medium">−{model.depositPaidLine}</span>
                  </p>
                  <p className="mt-1 flex items-center justify-between border-t border-emerald-400/20 pt-1 text-sm font-semibold text-emerald-300">
                    <span>Còn thu trên POS</span>
                    <span>{model.remainingLine}</span>
                  </p>
                </div>
              ) : null}
              {finalPriceAction ? <FinalPriceEditor action={finalPriceAction} /> : null}
            </section>

            {model.addons.length > 0 ? (
              <section
                className="space-y-1.5 border-t border-nq-muted/15 pt-4"
                data-testid="booking-drawer-addon"
              >
                <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                  {copy.sectionAddon}
                  {model.addons.length > 1 ? ` (${model.addons.length})` : ""}
                </p>
                <ul className="space-y-1">
                  {model.addons.map((a, i) => (
                    <li
                      key={`${a.name}-${i}`}
                      className="flex items-center gap-2 font-medium text-nq-foreground"
                    >
                      <span aria-hidden className="text-nq-muted">+</span>
                      <span>{a.name}</span>
                      {a.timingLabel ? (
                        <span className="rounded-full bg-nq-muted/15 px-2 py-0.5 text-[11px] font-medium text-nq-muted">
                          {a.timingLabel}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {model.addons.length === 1 && model.addonDurationLine ? (
                  <p className="text-nq-muted">{model.addonDurationLine}</p>
                ) : null}
              </section>
            ) : null}

            <section className="space-y-1 border-t border-nq-muted/15 pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                {copy.sectionStaff}
              </p>
              <p className="font-medium text-nq-foreground">{model.staffName}</p>
            </section>

            {/* Party composition — "who's going with whom". Lazily loaded for
                group bookings; only shown for a real multi-person party. */}
            {party && party.members.length > 1 ? (
              <section
                className="space-y-2 border-t border-nq-muted/15 pt-4"
                data-testid="drawer-party-section"
              >
                <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                  {copy.groupSectionTitle(party.members.length)}
                </p>
                {party.organizerName ? (
                  <p className="text-xs text-nq-muted">
                    {copy.groupOrganizedBy(party.organizerName)}
                  </p>
                ) : null}
                {model.seatTogether ? (
                  <p className="text-xs font-medium text-nq-primary">
                    {copy.groupSeatTogether}
                  </p>
                ) : null}
                <ul className="space-y-1.5">
                  {party.members.map((m) => (
                    <li
                      key={m.bookingId}
                      className="flex items-start gap-2 text-sm"
                    >
                      <span className="shrink-0 tabular-nums text-nq-muted/70">
                        {m.startDisplay}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 font-medium text-nq-foreground">
                          <span className="truncate">{m.name}</span>
                          {m.isOrganizer ? (
                            <span className="shrink-0 rounded bg-nq-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-nq-primary">
                              {copy.groupOrganizerBadge}
                            </span>
                          ) : null}
                        </p>
                        <p className="truncate text-xs text-nq-muted">
                          {m.serviceName}
                          {m.staffName ? ` · ${m.staffName}` : ""}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="space-y-1 border-t border-nq-muted/15 pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                {copy.sectionWhen}
              </p>
              <p
                data-testid="booking-drawer-schedule"
                className="font-medium text-nq-foreground"
              >
                {model.scheduleLine}
              </p>
              {/* "Khi nào book + book ở đâu" — when the booking was placed and
                  via which channel, so the desk can tell an online self-booking
                  from a front-desk entry without digging. */}
              {model.bookedAtLine ? (
                <p
                  className="text-xs text-nq-muted"
                  data-testid="booking-drawer-booked-at"
                >
                  {model.language === "vi" ? "Đặt lúc " : "Booked "}
                  {model.bookedAtLine}
                  {model.channelLabel ? <> · {model.channelLabel}</> : null}
                </p>
              ) : null}
              <p className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                {copy.sectionStatus}
              </p>
              <div className="mt-0.5">
                <Badge
                  variant={statusBadgeVariant(model.status)}
                  size="md"
                  data-testid="booking-drawer-status-badge"
                >
                  {model.statusLabel}
                </Badge>
              </div>

              {/* Verification + SMS + no-show-history badges */}
              {(model.smsFailedAt || model.verificationMethod || model.depositPaidLine || model.cardOnFile || model.noshowCardRequired || model.depositAwaitingLine || (model.noShowRiskScore != null && model.noShowRiskScore >= 70) || model.noShowHistoryCount > 0) ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {model.depositAwaitingLine ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] font-medium text-amber-400" data-testid="drawer-deposit-awaiting-badge">
                      ⏳ Chờ cọc {model.depositAwaitingLine}
                    </span>
                  ) : null}
                  {model.depositPaidLine ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400" data-testid="drawer-deposit-paid-badge">
                      💰 Đã cọc {model.depositPaidLine}
                    </span>
                  ) : null}
                  {model.cardOnFile ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400" data-testid="drawer-card-on-file-badge">
                      💳 {model.language === "vi" ? "Đã lưu thẻ" : "Card on file"}
                      {model.noshowFeeLine
                        ? (model.language === "vi"
                            ? ` · phí no-show ${model.noshowFeeLine}`
                            : ` · no-show fee ${model.noshowFeeLine}`)
                        : ""}
                    </span>
                  ) : model.noshowCardRequired ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] font-medium text-amber-400" data-testid="drawer-card-needed-badge">
                      ⚠ {model.language === "vi" ? "Cần lưu thẻ — chưa có" : "Needs card — none yet"}
                    </span>
                  ) : null}
                  {model.smsFailedAt ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] font-medium text-amber-400">
                      ⚠ SMS không gửi được
                    </span>
                  ) : null}
                  {model.verificationMethod === "otp" ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                      ✓ Đã verify OTP
                    </span>
                  ) : null}
                  {model.verificationMethod === "deposit" ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                      💰 Đã đặt cọc
                    </span>
                  ) : null}
                  {model.noShowRiskScore != null && model.noShowRiskScore >= 70 && !model.verificationMethod ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-red-400/40 bg-red-400/10 px-2 py-0.5 text-[11px] font-medium text-red-400">
                      ⚠ Rủi ro cao chưa verify ({model.noShowRiskScore})
                    </span>
                  ) : null}
                  {model.noShowHistoryCount > 0 ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-red-400/40 bg-red-400/10 px-2 py-0.5 text-[11px] font-medium text-red-400">
                      ⚠ Đã vắng {model.noShowHistoryCount} lần
                    </span>
                  ) : null}
                </div>
              ) : null}
            </section>

            <section className="space-y-1 border-t border-nq-muted/15 pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                {copy.sectionNotes}
              </p>
              {noteEditing ? (
                <div className="space-y-1">
                  <textarea
                    autoFocus
                    data-testid="drawer-note-input"
                    value={noteDraft}
                    disabled={noteSaving}
                    rows={3}
                    onChange={(e) => { setNoteDraft(e.target.value); setNoteErr(false); }}
                    onKeyDown={(e) => { if (e.key === "Escape") setNoteEditing(false); }}
                    className={cn(
                      "w-full rounded-lg border bg-nq-bg px-2 py-1.5 text-sm text-nq-foreground focus:outline-none focus:border-nq-primary/60",
                      noteErr ? "border-nq-error/70" : "border-nq-border/50",
                    )}
                    placeholder={model.language === "vi" ? "Ghi chú cho lịch hẹn này…" : "Note for this appointment…"}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      data-testid="drawer-note-save"
                      disabled={noteSaving}
                      onClick={saveNote}
                      className="rounded-lg bg-nq-primary px-2.5 py-1 text-xs font-semibold text-black disabled:opacity-50"
                    >
                      {noteSaving ? (model.language === "vi" ? "Đang lưu…" : "Saving…") : (model.language === "vi" ? "Lưu" : "Save")}
                    </button>
                    <button
                      type="button"
                      disabled={noteSaving}
                      onClick={() => { setNoteEditing(false); setNoteErr(false); }}
                      className="text-xs text-nq-muted underline-offset-2 hover:underline"
                    >
                      {model.language === "vi" ? "Huỷ" : "Cancel"}
                    </button>
                    {noteErr ? (
                      <span className="text-xs text-nq-error" role="alert">
                        {model.language === "vi" ? "Lưu lỗi." : "Save failed."}
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  {(noteOverride !== undefined ? noteOverride : model.clientNotes)?.trim() ? (
                    <p className="flex-1 break-words whitespace-pre-wrap text-nq-foreground/95">
                      {noteOverride !== undefined ? noteOverride : model.clientNotes}
                    </p>
                  ) : (
                    <p className="flex-1 italic text-nq-muted">{copy.noNotes}</p>
                  )}
                  {canEditName ? (
                    <button
                      type="button"
                      data-testid="drawer-note-edit"
                      aria-label={model.language === "vi" ? "Sửa ghi chú" : "Edit note"}
                      title={model.language === "vi" ? "Sửa ghi chú" : "Edit note"}
                      onClick={() => {
                        const cur = noteOverride !== undefined ? noteOverride : model.clientNotes;
                        setNoteDraft(cur ?? "");
                        setNoteErr(false);
                        setNoteEditing(true);
                      }}
                      className="shrink-0 text-nq-muted hover:text-nq-foreground"
                    >
                      ✏️
                    </button>
                  ) : null}
                </div>
              )}
              </section>
            </div>

            {showFooter ? (
              <div
                className={cn(
                  "flex shrink-0 flex-col gap-2 border-t border-nq-muted/20 bg-nq-surface px-4 pt-3",
                  "pb-[max(1rem,env(safe-area-inset-bottom))]",
                )}
              >
                {editMode && deskEdit ? (
                  <EditBookingForm
                    slug={deskEdit.slug}
                    booking={deskEdit.booking}
                    bookingId={deskEdit.booking.id}
                    salonId={deskEdit.salonId}
                    staff={deskEdit.staff}
                    services={deskEdit.services}
                    capabilityRows={deskEdit.capabilityRows}
                    dayYmd={deskEdit.dayYmd}
                    timezone={deskEdit.timezone}
                    rcMessages={deskEdit.rcMessages}
                    currency={deskEdit.currency}
                    isOffline={isOffline}
                    offlineEditDisabledHint={offlineEditDisabledHint}
                    onCancel={() => setEditMode(false)}
                    onSaved={(updated) => {
                      setEditMode(false);
                      void deskEdit.onBookingUpdated(updated);
                    }}
                  />
                ) : (
                  <>
                    {isOffline && offlineEditDisabledHint ? (
                      <p
                        className="text-xs font-semibold text-nq-error"
                        role="status"
                        data-testid="drawer-offline-hint"
                      >
                        {offlineEditDisabledHint}
                      </p>
                    ) : null}
                    <div className="flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-3">
                      {canEditBooking && deskEdit ? (
                        <Button
                          type="button"
                          variant="secondary"
                          data-testid="edit-booking-button"
                          className="w-full sm:min-w-0 sm:flex-1"
                          disabled={isOffline}
                          title={isOffline ? offlineEditDisabledHint : undefined}
                          onClick={() => setEditMode(true)}
                        >
                          {deskEdit.rcMessages.drawer.editBooking}
                        </Button>
                      ) : null}
                      {primaryAction !== undefined ? (
                        <Button
                          type="button"
                          variant="primary"
                          data-testid="drawer-primary-action"
                          loading={primaryAction.busy}
                          disabled={isOffline}
                          title={isOffline ? offlineEditDisabledHint : undefined}
                          className={cn(
                            "w-full sm:min-w-0",
                            canEditBooking ? "sm:flex-1" : "sm:w-full",
                          )}
                          onClick={() => void primaryAction.onPress()}
                        >
                          {primaryAction.label}
                        </Button>
                      ) : null}
                    </div>
                    {cancelAction !== undefined ? (
                      <Button
                        type="button"
                        variant="danger"
                        loading={cancelAction.busy}
                        data-testid="drawer-cancel-booking"
                        disabled={isOffline}
                        title={isOffline ? offlineEditDisabledHint : undefined}
                        className="w-full sm:w-full"
                        onClick={() => void cancelAction.onPress()}
                      >
                        {cancelAction.label}
                      </Button>
                    ) : null}
                    {restoreAction !== undefined ? (
                      <Button
                        type="button"
                        variant="secondary"
                        loading={restoreAction.busy}
                        data-testid="drawer-restore-booking"
                        disabled={isOffline}
                        title={isOffline ? offlineEditDisabledHint : undefined}
                        className="w-full sm:w-full"
                        onClick={() => void restoreAction.onPress()}
                      >
                        {restoreAction.label}
                      </Button>
                    ) : null}
                    {declineAction !== undefined ? (
                      <Button
                        type="button"
                        variant="danger"
                        loading={declineAction.busy}
                        data-testid="drawer-decline-wix"
                        disabled={isOffline}
                        title={isOffline ? offlineEditDisabledHint : undefined}
                        className="w-full sm:w-full"
                        onClick={() => void declineAction.onPress()}
                      >
                        {declineAction.label}
                      </Button>
                    ) : null}
                    {noShowAction !== undefined ? (
                      <Button
                        type="button"
                        variant="secondary"
                        loading={noShowAction.busy}
                        data-testid="drawer-no-show"
                        disabled={isOffline}
                        title={isOffline ? offlineEditDisabledHint : undefined}
                        className="w-full sm:w-full"
                        onClick={() => void noShowAction.onPress()}
                      >
                        {noShowAction.label}
                      </Button>
                    ) : null}
                    {deskEdit &&
                    model.depositsEnabled &&
                    model.verificationMethod !== "deposit" &&
                    !model.cardOnFile ? (
                      <DepositButton
                        slug={deskEdit.slug}
                        salonId={deskEdit.salonId}
                        bookingId={deskEdit.booking.id}
                        disabled={isOffline}
                        offlineHint={offlineEditDisabledHint}
                        language={model.language}
                      />
                    ) : null}
                    {deskEdit && model.depositsEnabled && model.noshowCardRequired && !model.cardOnFile ? (
                      <SaveCardButton
                        slug={deskEdit.slug}
                        bookingId={deskEdit.booking.id}
                        disabled={isOffline}
                        offlineHint={offlineEditDisabledHint}
                        language={model.language}
                      />
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );

  if (!portalEl) return null;

  return createPortal(sheet, portalEl);
}
