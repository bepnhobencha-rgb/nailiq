export type SquareVerifyDetails = {
  customerInitiated?: boolean;
  sellerKeyedIn?: boolean;
} & ({
  intent: "STORE";
  billingContact: Record<string, string>;
  amount?: never;
  currencyCode?: never;
} | {
  // Preserve compatibility with the separately typed deposit integration.
  // This card-on-file change neither dispatches nor changes deposit charges.
  intent: "CHARGE";
  billingContact?: Record<string, string>;
  amount?: string;
  currencyCode?: string;
});

export type SquareCard = {
  attach: (selector: string) => Promise<void>;
  destroy: () => Promise<boolean>;
  tokenize: (details?: SquareVerifyDetails) => Promise<{ status: string; token?: string }>;
};

export type SquareGlobal = {
  payments: (applicationId: string, locationId: string) => { card: () => Promise<SquareCard> };
};

declare global {
  interface Window { Square?: SquareGlobal }
}

export type SquareCardFormFailure = {
  stage: "sdk_load" | "payments_init" | "card_create" | "card_attach";
  code: string;
};

/** Square uses mixed-case failure statuses (Invalid/Error/Cancel). Retain
 * only known enum values; never put arbitrary provider text in diagnostics. */
export function safeSquareTokenizationStatus(value: unknown): string {
  const status = typeof value === "string" ? value.toUpperCase() : "";
  return ["OK", "ERROR", "INVALID", "CANCEL", "CANCELED", "ABORT"].includes(status) ? status : "OTHER";
}

type Environment = "sandbox" | "production";
const SDK_SRC: Record<Environment, string> = {
  sandbox: "https://sandbox.web.squarecdn.com/v1/square.js",
  production: "https://web.squarecdn.com/v1/square.js",
};
const SDK_LOAD_TIMEOUT_MS = 12_000;
const SAFE_SDK_ERRORS = new Set([
  "BrowserNotSupportedError", "WebSdkEmbedError", "PaymentMethodUnsupportedError",
  "ElementNotFoundError", "InvalidElementTypeError", "InvalidConfigurationValueError",
  "InvalidOptionError", "PaymentMethodAlreadyAttachedError", "PaymentMethodAlreadyDestroyedError",
  "PaymentMethodNotAttachedError", "UnexpectedError", "ApplicationIdEnvironmentMismatchError",
  "InvalidApplicationIdError", "InvalidLocationIdError",
]);
type LoadCode = "sdk_environment_invalid" | "sdk_environment_conflict" | "sdk_invalid_global" |
  "sdk_load_failed" | "sdk_load_timeout" | "sdk_no_global";
class SdkLoadError extends Error {
  constructor(readonly code: LoadCode) { super(code); this.name = "SdkLoadError"; }
}

function failure(stage: SquareCardFormFailure["stage"], error: unknown): SquareCardFormFailure {
  if (error instanceof SdkLoadError) return { stage, code: error.code };
  // SDK exceptions can cross realms. Read only the name, never the message,
  // stack or provider payload, and retain only explicitly known names.
  let name: unknown;
  try { name = error && typeof error === "object" ? (error as { name?: unknown }).name : null; }
  catch { name = null; }
  return { stage, code: typeof name === "string" && SAFE_SDK_ERRORS.has(name) ? name : "square_sdk_error" };
}

function validSdk(value: unknown): value is SquareGlobal {
  try {
    return !!value && (typeof value === "object" || typeof value === "function") &&
      typeof (value as SquareGlobal).payments === "function";
  } catch { return false; }
}

type PendingLoad = { environment: Environment; promise: Promise<SquareGlobal> };
const pendingLoads = new WeakMap<Document, PendingLoad>();

/** Share only an in-flight script load. Failed/timed-out scripts are removed so
 * a customer retry starts fresh. Never reuse the other environment's global. */
export function loadSquareWebPaymentsSdk(environment: Environment): Promise<SquareGlobal> {
  if (environment !== "sandbox" && environment !== "production") {
    return Promise.reject(new SdkLoadError("sdk_environment_invalid"));
  }
  const doc = document;
  const opposite = environment === "sandbox" ? "production" : "sandbox";
  if (doc.querySelector(`script[src="${SDK_SRC[opposite]}"]`)) {
    return Promise.reject(new SdkLoadError("sdk_environment_conflict"));
  }
  const pending = pendingLoads.get(doc);
  if (pending) return pending.environment === environment ? pending.promise
    : Promise.reject(new SdkLoadError("sdk_environment_conflict"));

  const existing = doc.querySelector<HTMLScriptElement>(`script[src="${SDK_SRC[environment]}"]`);
  if (window.Square !== undefined) {
    if (!validSdk(window.Square)) return Promise.reject(new SdkLoadError("sdk_invalid_global"));
    // An unlabelled pre-existing global cannot prove which environment loaded it.
    if (!existing) return Promise.reject(new SdkLoadError("sdk_environment_conflict"));
    return Promise.resolve(window.Square);
  }

  const script = existing ?? doc.createElement("script");
  const promise = new Promise<SquareGlobal>((resolve, reject) => {
    let settled = false;
    const clean = () => {
      clearTimeout(timeout);
      script.removeEventListener("load", loaded);
      script.removeEventListener("error", failed);
    };
    const finish = (error?: SdkLoadError) => {
      if (settled) return;
      settled = true;
      clean();
      if (error) { script.remove(); reject(error); }
      else resolve(window.Square!);
    };
    const loaded = () => finish(validSdk(window.Square) ? undefined
      : new SdkLoadError(window.Square === undefined ? "sdk_no_global" : "sdk_invalid_global"));
    const failed = () => finish(new SdkLoadError("sdk_load_failed"));
    const timeout = setTimeout(() => finish(new SdkLoadError("sdk_load_timeout")), SDK_LOAD_TIMEOUT_MS);
    script.addEventListener("load", loaded);
    script.addEventListener("error", failed);
    if (!existing) {
      script.src = SDK_SRC[environment];
      script.async = true;
      try { doc.head.appendChild(script); }
      catch { failed(); }
    }
  });
  const entry = { environment, promise };
  pendingLoads.set(doc, entry);
  const clearPending = () => { if (pendingLoads.get(doc) === entry) pendingLoads.delete(doc); };
  void promise.then(clearPending, clearPending);
  return promise;
}

/** Own exactly one card instance. Cancellation waits for pending creation or
 * attachment before disposal, so it never races destroy() against attach(). */
export function mountSquareCardForm(input: {
  loadSdk: () => Promise<SquareGlobal>;
  applicationId: string;
  locationId: string;
  selector: string;
  onReady: (card: SquareCard) => void;
  onError: (error: SquareCardFormFailure) => void;
}): () => void {
  let cancelled = false;
  let settled = false;
  let destroyed = false;
  let card: SquareCard | null = null;
  async function dispose() {
    if (!card || destroyed) return;
    destroyed = true;
    try { await card.destroy(); } catch { /* A cleanup error cannot revive a stale form. */ }
  }
  void (async () => {
    let stage: SquareCardFormFailure["stage"] = "sdk_load";
    let failed = false;
    try {
      const sdk = await input.loadSdk();
      if (cancelled) return;
      stage = "payments_init";
      const payments = sdk.payments(input.applicationId, input.locationId);
      stage = "card_create";
      card = await payments.card();
      if (cancelled) return;
      stage = "card_attach";
      await card.attach(input.selector);
      if (cancelled) return;
      settled = true;
      input.onReady(card);
    } catch (error) {
      failed = true;
      if (!cancelled) input.onError(failure(stage, error));
    } finally {
      settled = true;
      if (cancelled || failed) await dispose();
    }
  })();
  return () => { cancelled = true; if (settled) void dispose(); };
}
