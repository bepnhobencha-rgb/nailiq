const STORAGE_KEY = "nailiq-register-flow";
const COMPLETION_COOKIE = "nq_register_completion";

export type RegisterFlowData = {
  phone: string;
  verified: boolean;
  /** Issued server-side after OTP; required to create the salon */
  completionToken: string;
  salonName: string;
  slug: string;
};

const empty: RegisterFlowData = {
  phone: "",
  verified: false,
  completionToken: "",
  salonName: "",
  slug: "",
};

function read(): RegisterFlowData {
  if (typeof window === "undefined") return { ...empty };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...empty };
    const p = JSON.parse(raw) as Partial<RegisterFlowData>;
    return {
      phone: typeof p.phone === "string" ? p.phone : "",
      verified: Boolean(p.verified),
      completionToken:
        typeof p.completionToken === "string" ? p.completionToken : "",
      salonName: typeof p.salonName === "string" ? p.salonName : "",
      slug: typeof p.slug === "string" ? p.slug : "",
    };
  } catch {
    return { ...empty };
  }
}

function write(data: RegisterFlowData) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // ignore
  }
}

/** Cookie fallback if localStorage is blocked or cleared between steps. */
export function readRegisterCompletionTokenFromCookie(): string {
  if (typeof window === "undefined") return "";
  try {
    const m = document.cookie.match(/(?:^|; )nq_register_completion=([^;]*)/);
    return m?.[1] ? decodeURIComponent(m[1]) : "";
  } catch {
    return "";
  }
}

export function setRegisterCompletionCookie(token: string) {
  if (typeof window === "undefined" || !token) return;
  try {
    const maxAge = 30 * 60;
    document.cookie = `${COMPLETION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
  } catch {
    // ignore
  }
}

export function clearRegisterCompletionCookie() {
  if (typeof window === "undefined") return;
  try {
    document.cookie = `${COMPLETION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  } catch {
    // ignore
  }
}

/** Prefer localStorage; fall back to completion cookie. */
export function getRegisterCompletionTokenClient(): string {
  const fromStorage = read().completionToken;
  if (fromStorage) return fromStorage;
  return readRegisterCompletionTokenFromCookie();
}

export function getRegisterFlow(): RegisterFlowData {
  return read();
}

export function setRegisterFlow(partial: Partial<RegisterFlowData>) {
  const next = { ...read(), ...partial };
  write(next);
  return next;
}

export function clearRegisterFlow() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  clearRegisterCompletionCookie();
}

/**
 * "A Nails" → "a-nails"
 */
export function slugifySalonName(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "my-salon";
}
