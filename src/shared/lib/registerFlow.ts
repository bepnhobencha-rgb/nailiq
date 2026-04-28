const STORAGE_KEY = "nailiq-register-flow";

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
