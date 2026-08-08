export type SquareConnectionStatus = {
  canManage: boolean;
  connected: boolean;
  credentialsStored: boolean;
  enabled: boolean;
  paymentProvider: string | null;
  merchantId: string | null;
  locationId: string | null;
  applicationId: string | null;
  environment: string | null;
  bookingSyncReady: boolean;
  pushWritesEnabled: boolean;
  lastError: string | null;
  updatedAt: string | null;
};

export type LoadSquareConnectionResult =
  | { ok: true; status: SquareConnectionStatus }
  | { ok: false; error: "unauthorized" | "not_found" | "server_error" };

export type SquareConnectError =
  | "unauthorized"
  | "founder_required"
  | "mfa_required"
  | "invalid_input"
  | "rate_limited"
  | "invalid_credentials"
  | "square_unavailable"
  | "location_ambiguous"
  | "account_conflict"
  | "payment_provider_conflict"
  | "saved_card_conflict"
  | "audit_failed"
  | "server_error";

export type SquareConnectActionState =
  | { ok: null }
  | { ok: false; error: SquareConnectError; message?: string }
  | {
      ok: true;
      connected: {
        businessName: string | null;
        locationName: string;
        merchantId: string;
        locationId: string;
        currency: string | null;
        bookingSyncReady: boolean;
      };
    };

export const INITIAL_SQUARE_CONNECT_STATE: SquareConnectActionState = {
  ok: null,
};
