const SQUARE_API = "https://connect.squareup.com/v2";
const SQUARE_TOKEN_STATUS = "https://connect.squareup.com/oauth2/token/status";
const SQUARE_VERSION = "2024-12-18";

type FetchLike = typeof fetch;

export type SquareConnectionValidationCode =
  | "invalid_credentials"
  | "token_expired"
  | "token_revoked"
  | "client_disabled"
  | "insufficient_scopes"
  | "square_forbidden"
  | "square_unavailable"
  | "location_ambiguous";

export type ValidatedSquareConnection = {
  merchantId: string;
  merchantBusinessName: string | null;
  locationId: string;
  locationName: string;
  currency: string | null;
  bookingSyncReady: boolean;
};

export class SquareConnectionValidationError extends Error {
  constructor(public readonly code: SquareConnectionValidationCode) {
    super(code);
    this.name = "SquareConnectionValidationError";
  }
}

type SquareLocation = {
  id?: unknown;
  merchant_id?: unknown;
  name?: unknown;
  business_name?: unknown;
  status?: unknown;
  currency?: unknown;
};

type SquareMerchant = {
  id?: unknown;
  business_name?: unknown;
};

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function authenticationErrorCode(
  payload: Record<string, unknown>,
  status: number,
): SquareConnectionValidationCode {
  const errors = Array.isArray(payload.errors)
    ? (payload.errors as Array<{ code?: unknown }>)
    : [];
  const providerCode = errors
    .map((error) => cleanString(error.code))
    .find(Boolean);

  switch (providerCode) {
    case "ACCESS_TOKEN_EXPIRED":
      return "token_expired";
    case "ACCESS_TOKEN_REVOKED":
      return "token_revoked";
    case "CLIENT_DISABLED":
      return "client_disabled";
    case "INSUFFICIENT_SCOPES":
      return "insufficient_scopes";
    case "FORBIDDEN":
      return "square_forbidden";
    default:
      return status === 403 ? "square_forbidden" : "invalid_credentials";
  }
}

async function squareRequest(
  url: string,
  accessToken: string,
  fetchImpl: FetchLike,
  method: "GET" | "POST",
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Square-Version": SQUARE_VERSION,
        Accept: "application/json",
      },
    });
  } catch {
    throw new SquareConnectionValidationError("square_unavailable");
  }

  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (response.status === 401 || response.status === 403) {
    throw new SquareConnectionValidationError(
      authenticationErrorCode(payload, response.status),
    );
  }
  if (!response.ok) {
    throw new SquareConnectionValidationError("square_unavailable");
  }
  return payload;
}

async function squareJson(
  path: string,
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<Record<string, unknown>> {
  return squareRequest(
    `${SQUARE_API}${path}`,
    accessToken,
    fetchImpl,
    "GET",
  );
}

/**
 * Validates a production personal access token without creating a payment,
 * booking, customer, or webhook. Exactly one ACTIVE location is required so
 * NailIQ never guesses which business a credential belongs to.
 */
export async function validateSquareProductionConnection(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<ValidatedSquareConnection> {
  await squareRequest(
    SQUARE_TOKEN_STATUS,
    accessToken,
    fetchImpl,
    "POST",
  );

  const [locationsPayload, merchantsPayload] = await Promise.all([
    squareJson("/locations", accessToken, fetchImpl),
    squareJson("/merchants", accessToken, fetchImpl),
  ]);

  const locations = Array.isArray(locationsPayload.locations)
    ? (locationsPayload.locations as SquareLocation[])
    : [];
  const active = locations.filter((location) => location.status === "ACTIVE");
  if (active.length !== 1) {
    throw new SquareConnectionValidationError("location_ambiguous");
  }

  const location = active[0];
  const locationId = cleanString(location.id);
  const merchantIdFromLocation = cleanString(location.merchant_id);
  if (!locationId || !merchantIdFromLocation) {
    throw new SquareConnectionValidationError("square_unavailable");
  }

  const merchants = Array.isArray(merchantsPayload.merchant)
    ? (merchantsPayload.merchant as SquareMerchant[])
    : Array.isArray(merchantsPayload.merchants)
      ? (merchantsPayload.merchants as SquareMerchant[])
      : [];
  const merchant = merchants.find(
    (candidate) => cleanString(candidate.id) === merchantIdFromLocation,
  );

  let bookingSyncReady = false;
  try {
    const profilesPayload = await squareJson(
      "/bookings/location-booking-profiles",
      accessToken,
      fetchImpl,
    );
    const profiles = Array.isArray(profilesPayload.location_booking_profiles)
      ? (profilesPayload.location_booking_profiles as Array<{
          location_id?: unknown;
        }>)
      : [];
    bookingSyncReady = profiles.some(
      (profile) => cleanString(profile.location_id) === locationId,
    );
  } catch (error) {
    if (
      error instanceof SquareConnectionValidationError &&
      [
        "invalid_credentials",
        "token_expired",
        "token_revoked",
        "client_disabled",
      ].includes(error.code)
    ) {
      throw error;
    }
    // A Square account can accept cards without enabling Square Bookings.
    // Keep booking sync disabled instead of rejecting a valid payment account.
    bookingSyncReady = false;
  }

  return {
    merchantId: merchantIdFromLocation,
    merchantBusinessName: cleanString(merchant?.business_name),
    locationId,
    locationName:
      cleanString(location.name) ??
      cleanString(location.business_name) ??
      "Square location",
    currency: cleanString(location.currency)?.toUpperCase() ?? null,
    bookingSyncReady,
  };
}
