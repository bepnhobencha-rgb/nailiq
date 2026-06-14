// Live, per-salon + per-role context for the agentic admin copilot (Coco).
// Everything here is READ-ONLY. Coco uses this to tailor guidance to THIS
// salon's real state (today's bookings, walk-in queue, no-shows, staff, setup
// gaps) and THIS user's role, and a read-only tool to look up a client's
// appointments on demand. Coco guides and reads; it never mutates data.

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import type { SalonMemberRole } from "@/shared/lib/salonMemberRole";
import { salonToday, salonDayRangeUtc } from "@/shared/lib/salonTime";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { parseTimeSlotToMinutes } from "@/shared/booking/parseBookingTimeSlot";
import { formatCurrency, parseCurrency } from "@/shared/lib/currencyFormat";

type Ctx = NonNullable<Awaited<ReturnType<typeof getDashboardWriteClient>>>;
export type CopilotDb = Ctx["supabase"];
export type CopilotSalon = Ctx["salon"];

/**
 * A fully-resolved appointment Coco wants to create, returned by the
 * `prepare_appointment` tool. The params travel to the client as STRUCTURED
 * data (never through the model's free text), so the user confirms exactly what
 * was validated — and the real create still runs through `addDeskAppointment`
 * (conflict / past-time / capability / buffer / plan-limit guards) on confirm.
 */
export type CocoBookingProposal = {
  salonId: string;
  serviceId: string;
  serviceName: string;
  /** staff UUID, or BOOKING_ANY_STAFF_ID for "any available". */
  staffId: string;
  staffName: string;
  bookingDateYmd: string;
  /** Slot label exactly as the desk form expects, e.g. "3:00 PM". */
  timeSlot: string;
  clientName: string;
  clientPhone: string;
  priceLabel: string;
};

/** runCopilotTool result: the AI-facing string + an optional structured
 *  proposal the route surfaces to the client for confirmation. */
export type CopilotToolResult = { content: string; proposal?: CocoBookingProposal };

// Dashboard areas mapped to the roles that can actually reach them, so Coco
// only guides what THIS user can do. Paths are built per-request with the slug.
const AREAS: { label: string; path: (slug: string) => string; roles: SalonMemberRole[] }[] = [
  { label: "Home / today overview", path: (s) => `/dashboard/${s}`, roles: ["owner", "admin"] },
  { label: "Front Desk (Receptionist Center)", path: (s) => `/dashboard/${s}/center`, roles: ["owner", "admin", "senior", "receptionist", "nail_tech"] },
  { label: "Clients", path: (s) => `/dashboard/${s}/clients`, roles: ["owner", "admin", "senior", "receptionist"] },
  { label: "Reports", path: (s) => `/dashboard/${s}/reports`, roles: ["owner", "admin"] },
  { label: "Settings (brand, hours, staff, services, integrations)", path: (s) => `/dashboard/${s}/settings`, roles: ["owner", "admin"] },
  { label: "Setup wizard", path: (s) => `/dashboard/${s}/setup`, roles: ["owner", "admin"] },
];

function roleLabel(role: SalonMemberRole): string {
  switch (role) {
    case "owner": return "Owner (full access)";
    case "admin": return "Admin (manages day-to-day)";
    case "senior": return "Senior staff (front desk + edit bookings)";
    case "receptionist": return "Receptionist (front desk only)";
    case "nail_tech": return "Nail tech (view-only schedule)";
    default: return role;
  }
}

/**
 * Build a compact, live context block injected into Coco's system prompt on
 * every request. Cheap: a handful of COUNT queries + the salon row we already
 * have. Read-only.
 */
export async function buildCopilotContext(args: {
  db: CopilotDb;
  salon: CopilotSalon;
  role: SalonMemberRole;
}): Promise<string> {
  const { db, salon, role } = args;
  const tz = salon.timezone || "America/Los_Angeles";
  const { startUtc, endUtc } = salonDayRangeUtc(salonToday(tz), tz);

  const sid = salon.id;
  const bk = () => db.from("bookings").select("*", { count: "exact", head: true }).eq("salon_id", sid);

  const [
    upcomingToday,
    inProgress,
    walkinWaiting,
    noShowToday,
    completedToday,
    staffActive,
    servicesActive,
  ] = await Promise.all([
    bk().gte("start_time_utc", startUtc).lt("start_time_utc", endUtc).in("status", ["pending", "confirmed"] as never),
    bk().eq("status", "in_progress" as never),
    bk().eq("source", "walkin" as never).eq("status", "waiting" as never),
    bk().gte("start_time_utc", startUtc).lt("start_time_utc", endUtc).eq("status", "no_show" as never),
    bk().gte("start_time_utc", startUtc).lt("start_time_utc", endUtc).eq("status", "completed" as never),
    db.from("staff").select("*", { count: "exact", head: true }).eq("salon_id", sid).eq("status", "active" as never).is("deleted_at" as never, null),
    db.from("services").select("*", { count: "exact", head: true }).eq("salon_id", sid).is("deleted_at" as never, null),
  ]);

  const services = servicesActive.count ?? 0;
  const staff = staffActive.count ?? 0;

  // --- Setup readiness (what's blocking the salon from taking bookings) ---
  const gaps: string[] = [];
  if (services === 0) gaps.push(`No services yet — add at least one (Settings /dashboard/${salon.slug}/settings or the Setup wizard /dashboard/${salon.slug}/setup).`);
  if (staff === 0) gaps.push(`No active staff yet — add a bookable staff member (Settings /dashboard/${salon.slug}/settings).`);
  if (!salon.profile_complete) gaps.push(`Salon profile is incomplete — finish it in the Setup wizard /dashboard/${salon.slug}/setup.`);

  // --- Areas this role can reach ---
  const allowed = AREAS.filter((a) => a.roles.includes(role)).map((a) => `${a.label} (${a.path(salon.slug)})`);

  return `=== LIVE CONTEXT (use to personalise guidance; do not invent beyond this) ===
Salon: ${salon.name} (slug: ${salon.slug}, timezone: ${tz})
User role: ${roleLabel(role)}
Areas this user can reach: ${allowed.join("; ") || "(none)"}

Today's real-time state:
- Upcoming appointments today (pending/confirmed): ${upcomingToday.count ?? 0}
- Currently in progress: ${inProgress.count ?? 0}
- Walk-ins waiting in the queue: ${walkinWaiting.count ?? 0}
- No-shows today: ${noShowToday.count ?? 0}
- Completed today: ${completedToday.count ?? 0}
- Active (bookable) staff: ${staff}
- Active services: ${services}

Setup still needed (mention proactively if relevant to the question, or when the user asks "what do I need to do"):
${gaps.length ? gaps.map((g) => "- " + g).join("\n") : "- (Nothing missing — the salon is ready to take bookings.)"}
=== END LIVE CONTEXT ===`;
}

// --- Agentic read-only tool: look up a client's appointments on demand ---

export const COPILOT_TOOLS = [
  {
    name: "find_appointment",
    description:
      "Look up a client's appointments by their name or phone number, to answer questions like 'when is Anna booked?' or 'does 604-555-1234 have an appointment today?'. Read-only — never changes anything.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Client name or phone number to search for, e.g. 'Anna' or '6045551234'." },
      },
      required: ["query"],
    },
  },
  {
    name: "prepare_appointment",
    description:
      "Use when the user asks YOU to book / create a new appointment for a customer (e.g. 'đặt hẹn cho chị Lan, gel mani, 3h chiều mai với Anna'). This does NOT create anything — it resolves the service/staff/date/time, validates them, and returns a proposal the user must CONFIRM with a button before it's booked. Gather: customer name, phone, service, staff (or 'any'), date (YYYY-MM-DD — convert words like 'tomorrow' using today's date from the LIVE CONTEXT), and a time like '3:00 PM'. Ask for anything missing before calling. After it returns, tell the user to tap Confirm — NEVER say it's booked yet.",
    input_schema: {
      type: "object" as const,
      properties: {
        clientName: { type: "string", description: "Customer's name." },
        clientPhone: { type: "string", description: "Customer's phone number." },
        serviceName: { type: "string", description: "Service name as the user said it (matched against the salon's services)." },
        staffName: { type: "string", description: "Requested staff name, or 'any' / empty for any available staff." },
        date: { type: "string", description: "Appointment date as YYYY-MM-DD in the salon's local calendar." },
        time: { type: "string", description: "Start time label, e.g. '3:00 PM' or '15:00'." },
      },
      required: ["clientName", "clientPhone", "serviceName", "date", "time"],
    },
  },
];

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  waiting: "Waiting (walk-in)",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};

function formatLocal(iso: string | null, tz: string): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export async function runCopilotTool(args: {
  db: CopilotDb;
  salonId: string;
  timezone: string;
  name: string;
  input: Record<string, unknown>;
}): Promise<CopilotToolResult> {
  const { db, salonId, timezone, name, input } = args;

  if (name === "prepare_appointment") {
    return prepareAppointment(db, salonId, timezone, input);
  }

  if (name === "find_appointment") {
    // Strip characters that would break the PostgREST `or` filter syntax.
    const q = String(input.query || "").trim().replace(/[^\p{L}\p{N}\s+@.-]/gu, "");
    if (!q) return { content: JSON.stringify({ error: "Missing search query." }) };
    const like = `%${q}%`;

    const { data, error } = await db
      .from("bookings")
      .select(
        "id, client_name, client_phone, start_time_utc, status, staff_id, services!bookings_service_id_fkey ( name )",
      )
      .eq("salon_id", salonId)
      .or(`client_name.ilike.${like},client_phone.ilike.${like}`)
      .order("start_time_utc", { ascending: false })
      .limit(6);

    if (error) return { content: JSON.stringify({ error: "Lookup failed." }) };
    const rows = (data ?? []) as unknown as Array<{
      id: string;
      client_name: string;
      client_phone: string | null;
      start_time_utc: string | null;
      status: string;
      staff_id: string | null;
      services: { name: string } | { name: string }[] | null;
    }>;
    if (rows.length === 0) return { content: JSON.stringify({ found: false, message: `No appointments found for "${q}".` }) };

    // Resolve staff names in one round-trip (FK join name not assumed).
    const staffIds = [...new Set(rows.map((r) => r.staff_id).filter((x): x is string => !!x))];
    const staffMap = new Map<string, string>();
    if (staffIds.length) {
      const { data: staff } = await db.from("staff").select("id, name").in("id", staffIds);
      for (const s of (staff ?? []) as Array<{ id: string; name: string }>) staffMap.set(s.id, s.name);
    }

    return { content: JSON.stringify({
      found: true,
      count: rows.length,
      appointments: rows.map((r) => {
        const svc = Array.isArray(r.services) ? r.services[0] : r.services;
        return {
          client: r.client_name,
          phone: r.client_phone || null,
          when: formatLocal(r.start_time_utc, timezone),
          service: svc?.name || null,
          staff: r.staff_id ? staffMap.get(r.staff_id) || null : null,
          status: STATUS_LABEL[r.status] || r.status,
        };
      }),
    }) };
  }

  return { content: JSON.stringify({ error: `Unknown tool: ${name}` }) };
}

/**
 * Resolve + validate an appointment the user asked Coco to book. READ-ONLY:
 * matches the service + staff by name, checks the date isn't in the past, and
 * returns a structured proposal for the client to confirm. The authoritative
 * availability + creation happens in `addDeskAppointment` on confirm.
 */
async function prepareAppointment(
  db: CopilotDb,
  salonId: string,
  timezone: string,
  input: Record<string, unknown>,
): Promise<CopilotToolResult> {
  const clientName = String(input.clientName ?? "").trim();
  const clientPhone = String(input.clientPhone ?? "").trim();
  const serviceName = String(input.serviceName ?? "").trim();
  const staffName = String(input.staffName ?? "").trim();
  const dateYmd = String(input.date ?? "").trim();
  const timeRaw = String(input.time ?? "").trim();

  const err = (message: string, extra?: Record<string, unknown>) =>
    ({ content: JSON.stringify({ ok: false, message, ...extra }) } as CopilotToolResult);

  if (!clientName) return err("Missing the customer's name — ask for it.");
  if (!clientPhone) return err("Missing the customer's phone number — ask for it.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) return err("Need the date as YYYY-MM-DD.");
  if (dateYmd < salonToday(timezone, new Date().toISOString())) {
    return err("That date is in the past — pick today or a future date.");
  }
  const startMinutes = parseTimeSlotToMinutes(timeRaw);
  if (!Number.isFinite(startMinutes) || startMinutes < 0) {
    return err(`Couldn't read the time "${timeRaw}". Ask for a time like '3:00 PM'.`);
  }

  // Resolve the service by name among the salon's live, bookable (non-add-on)
  // services. Prefer an exact (case-insensitive) match, else a unique partial.
  const { data: svcRows } = await db
    .from("services")
    .select("id, name, price_cents, is_addon, deleted_at")
    .eq("salon_id", salonId)
    .is("deleted_at" as never, null);
  const services = ((svcRows ?? []) as Array<{
    id: string; name: string; price_cents: number | null; is_addon: boolean | null;
  }>).filter((s) => s.is_addon !== true);
  if (services.length === 0) return err("This salon has no bookable services yet.");
  const wantSvc = serviceName.toLowerCase();
  const exactSvc = services.find((s) => s.name.toLowerCase() === wantSvc);
  const partialSvc = services.filter((s) => s.name.toLowerCase().includes(wantSvc));
  const service = exactSvc ?? (partialSvc.length === 1 ? partialSvc[0] : null);
  if (!service) {
    return err(
      partialSvc.length === 0
        ? `No service matches "${serviceName}".`
        : `"${serviceName}" matches several services — ask which one.`,
      { services: services.map((s) => s.name) },
    );
  }

  // Resolve staff: empty / "any" → any-available sentinel; else a unique active
  // staff name match.
  const anyStaffWords = ["", "any", "anyone", "any available", "bất kỳ", "ai cũng được", "thợ nào cũng được"];
  let staffId: string = BOOKING_ANY_STAFF_ID;
  let staffLabel = "Any available staff";
  if (!anyStaffWords.includes(staffName.toLowerCase())) {
    const { data: staffRows } = await db
      .from("staff")
      .select("id, name, status")
      .eq("salon_id", salonId)
      .eq("status", "active" as never)
      .is("deleted_at" as never, null);
    const staff = (staffRows ?? []) as Array<{ id: string; name: string }>;
    const want = staffName.toLowerCase();
    const matches =
      staff.filter((s) => s.name.toLowerCase() === want).length > 0
        ? staff.filter((s) => s.name.toLowerCase() === want)
        : staff.filter((s) => s.name.toLowerCase().includes(want));
    if (matches.length === 0) {
      return err(`No active staff named "${staffName}".`, { staff: staff.map((s) => s.name) });
    }
    if (matches.length > 1) {
      return err(`"${staffName}" matches several staff — ask which one.`, { staff: matches.map((s) => s.name) });
    }
    staffId = matches[0].id;
    staffLabel = matches[0].name;
  }

  // Price label in the salon's currency (read the currency once).
  const { data: salonRow } = await db
    .from("salons")
    .select("currency_code")
    .eq("id", salonId)
    .maybeSingle();
  const currency = parseCurrency((salonRow as { currency_code?: unknown } | null)?.currency_code);
  const priceLabel =
    service.price_cents != null ? formatCurrency(service.price_cents, currency) ?? "—" : "—";

  const proposal: CocoBookingProposal = {
    salonId,
    serviceId: service.id,
    serviceName: service.name,
    staffId,
    staffName: staffLabel,
    bookingDateYmd: dateYmd,
    timeSlot: timeRaw,
    clientName,
    clientPhone,
    priceLabel,
  };

  // The AI-facing summary lets Coco narrate; the real params ride in `proposal`.
  return {
    content: JSON.stringify({
      ok: true,
      message: "Proposal ready — ask the user to tap Confirm to book it.",
      summary: { client: clientName, phone: clientPhone, service: service.name, staff: staffLabel, date: dateYmd, time: timeRaw, price: priceLabel },
    }),
    proposal,
  };
}
