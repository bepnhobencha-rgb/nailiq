import {
  Calendar,
  ClipboardList,
  CreditCard,
  Globe,
  LayoutTemplate,
  Mic,
  Phone,
  UserPlus,
  Bot,
  type LucideIcon,
} from "lucide-react";

/**
 * Maps a booking's source channel to a compact Lucide icon + accessible
 * label (P1 readability — source shown icon-only on the timeline block,
 * full label in tooltip + detail drawer).
 *
 * Display-only. The raw source string comes from `bookings.source` (DB
 * allows 'appointment' | 'walkin' | 'voice'); richer values ('online',
 * 'phone', 'ai') are mapped too so the surface is future-ready if the
 * loader starts surfacing them. Unknown / missing → null (hide safely).
 *
 * Labels here are English defaults; callers may pass a localized label map
 * for the accessible title (VI/EN parity).
 */

export type BookingSourceIconMeta = {
  Icon: LucideIcon;
  /** Default English label — override via the labels map for i18n. */
  label: string;
};

export type BookingSourceLabels = Partial<
  Record<
    | "online"
    | "square"
    | "wix"
    | "voice"
    | "ai"
    | "phone"
    | "walkin"
    | "desk"
    | "appointment",
    string
  >
>;

const DEFAULTS: Record<string, BookingSourceIconMeta> = {
  online: { Icon: Globe, label: "Online" },
  square: { Icon: CreditCard, label: "Square" },
  wix: { Icon: LayoutTemplate, label: "Wix" },
  desk: { Icon: ClipboardList, label: "Front desk" },
  appointment: { Icon: Calendar, label: "Appointment" },
  voice: { Icon: Mic, label: "Voice AI" },
  ai: { Icon: Bot, label: "AI Receptionist" },
  phone: { Icon: Phone, label: "Phone" },
  walkin: { Icon: UserPlus, label: "Walk-in" },
  walk_in: { Icon: UserPlus, label: "Walk-in" },
};

/**
 * Resolve the icon + label for a source value. Returns null for unknown or
 * empty sources so the block can omit the icon safely.
 */
export function bookingSourceIcon(
  source: string | null | undefined,
  labels?: BookingSourceLabels,
): BookingSourceIconMeta | null {
  if (!source) return null;
  const key = source.trim().toLowerCase();
  const meta = DEFAULTS[key];
  if (!meta) return null;

  // Allow a localized label override keyed by the canonical source.
  const localized =
    labels && (labels as Record<string, string | undefined>)[key === "walk_in" ? "walkin" : key];
  return { Icon: meta.Icon, label: localized?.trim() || meta.label };
}
