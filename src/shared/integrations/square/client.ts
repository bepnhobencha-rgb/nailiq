/**
 * Square REST client for NailIQ imports (customers, catalog, bookings).
 *
 * App-agnostic transport + thin Square-specific paginators. Credentials are
 * read from the per-salon `square_integrations` row (service-role only), never
 * hardcoded — mirrors the Wix integration's `client.ts` posture.
 */

const SQUARE_API = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";

export interface SquareConfig {
  salonId: string;
  merchantId: string;
  locationId: string;
  accessToken: string;
}

export interface SquareCustomer {
  id: string;
  given_name?: string;
  family_name?: string;
  phone_number?: string;
  email_address?: string;
  created_at?: string;
  creation_source?: string;
}

export interface SquareCatalogItem {
  id: string;
  name: string;
  description?: string;
  variations: { id: string; name?: string; priceCents: number | null }[];
  isAddon: boolean;
}

export interface SquareBooking {
  id: string;
  status: string;
  start_at?: string;
  customer_id?: string;
  location_id?: string;
  appointment_segments?: {
    duration_minutes?: number;
    service_variation_id?: string;
    team_member_id?: string;
  }[];
}

type Db = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: unknown; error: unknown }> };
    };
  };
};

/** Load Square credentials for a salon from the service-role DB. */
export async function getSquareConfig(db: Db, salonId: string): Promise<SquareConfig> {
  const { data, error } = await db
    .from("square_integrations")
    .select("salon_id, merchant_id, location_id, access_token")
    .eq("salon_id", salonId)
    .maybeSingle();
  if (error) throw new Error(`square_integrations load failed: ${JSON.stringify(error)}`);
  const row = data as {
    salon_id: string;
    merchant_id: string;
    location_id: string;
    access_token: string | null;
  } | null;
  if (!row) throw new Error(`No square_integrations row for salon ${salonId}`);
  if (!row.access_token) throw new Error(`square_integrations.access_token is empty for salon ${salonId}`);
  return {
    salonId: row.salon_id,
    merchantId: row.merchant_id,
    locationId: row.location_id,
    accessToken: row.access_token,
  };
}

async function squareReq(
  cfg: SquareConfig,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${SQUARE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`Square ${method} ${path} -> ${res.status}: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json;
}

/** Pull every customer for the merchant (paginated). */
export async function listAllCustomers(cfg: SquareConfig): Promise<SquareCustomer[]> {
  const out: SquareCustomer[] = [];
  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = { limit: 100 };
    if (cursor) body.cursor = cursor;
    const json = await squareReq(cfg, "POST", "/customers/search", body);
    out.push(...((json.customers as SquareCustomer[]) ?? []));
    cursor = json.cursor as string | undefined;
  } while (cursor);
  return out;
}

/** Pull catalog ITEMs with their variations + price, flagging add-ons. */
export async function listCatalogItems(cfg: SquareConfig): Promise<SquareCatalogItem[]> {
  const out: SquareCatalogItem[] = [];
  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = { object_types: ["ITEM"], limit: 200 };
    if (cursor) body.cursor = cursor;
    const json = await squareReq(cfg, "POST", "/catalog/search", body);
    for (const o of (json.objects as Record<string, unknown>[]) ?? []) {
      const it = (o.item_data as Record<string, unknown>) ?? {};
      const variations = ((it.variations as Record<string, unknown>[]) ?? []).map((v) => {
        const vd = (v.item_variation_data as Record<string, unknown>) ?? {};
        const pm = (vd.price_money as Record<string, unknown>) ?? {};
        return {
          id: v.id as string,
          name: vd.name as string | undefined,
          priceCents: (pm.amount as number | undefined) ?? null,
        };
      });
      out.push({
        id: o.id as string,
        name: (it.name as string) ?? "",
        description: it.description as string | undefined,
        variations,
        isAddon: false, // Square has no add-on flag; caller decides from name/price.
      });
    }
    cursor = json.cursor as string | undefined;
  } while (cursor);
  return out;
}

/** Rename a Square team member (sparse update — only the given fields change). */
export async function updateTeamMemberName(
  cfg: SquareConfig,
  teamMemberId: string,
  givenName: string,
  familyName = "",
): Promise<void> {
  await squareReq(cfg, "PUT", `/team-members/${teamMemberId}`, {
    team_member: { given_name: givenName, family_name: familyName },
  });
}

export interface SquarePayment {
  id: string;
  status: string;
  created_at?: string;
  amount_money?: { amount?: number; currency?: string };
  tip_money?: { amount?: number };
  refunded_money?: { amount?: number };
  source_type?: string;
}

/** Pull completed payments for the location in [begin, end) (paginated). */
export async function listPayments(
  cfg: SquareConfig,
  begin: Date,
  end: Date,
): Promise<SquarePayment[]> {
  const out: SquarePayment[] = [];
  let cursor: string | undefined;
  do {
    const qs = new URLSearchParams({
      location_id: cfg.locationId,
      begin_time: begin.toISOString(),
      end_time: end.toISOString(),
      sort_order: "ASC",
      limit: "100",
    });
    if (cursor) qs.set("cursor", cursor);
    const json = await squareReq(cfg, "GET", `/payments?${qs.toString()}`);
    out.push(...((json.payments as SquarePayment[]) ?? []));
    cursor = json.cursor as string | undefined;
  } while (cursor);
  return out;
}

/**
 * List bookings for the configured location across a date range. Square caps
 * each query at 31 days, so we walk the window month-by-month.
 */
export async function listBookings(
  cfg: SquareConfig,
  startAtMin: Date,
  startAtMax: Date,
): Promise<SquareBooking[]> {
  const out: SquareBooking[] = [];
  const DAY = 86_400_000;
  let windowStart = startAtMin.getTime();
  const end = startAtMax.getTime();
  while (windowStart < end) {
    const windowEnd = Math.min(windowStart + 30 * DAY, end);
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({
        location_id: cfg.locationId,
        start_at_min: new Date(windowStart).toISOString(),
        start_at_max: new Date(windowEnd).toISOString(),
        limit: "200",
      });
      if (cursor) qs.set("cursor", cursor);
      const json = await squareReq(cfg, "GET", `/bookings?${qs.toString()}`);
      out.push(...((json.bookings as SquareBooking[]) ?? []));
      cursor = json.cursor as string | undefined;
    } while (cursor);
    windowStart = windowEnd;
  }
  return out;
}
