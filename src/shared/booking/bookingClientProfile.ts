const KEY = "nailiq-booking-guest-profile";

export type SavedBookingGuestProfile = {
  name: string;
  phone: string;
};

export function loadSavedBookingGuestProfile(): SavedBookingGuestProfile | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : "";
    const phone = typeof o.phone === "string" ? o.phone : "";
    if (!name.trim() && !phone.trim()) return null;
    return { name, phone };
  } catch {
    return null;
  }
}

export function saveBookingGuestProfile(profile: SavedBookingGuestProfile): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        name: profile.name.trim(),
        phone: profile.phone.trim(),
      }),
    );
  } catch {
    // ignore quota / private mode
  }
}
