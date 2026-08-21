export type EmailBrandHeaderInput = {
  salonName: string;
  logoUrl?: string | null;
  subtitle: string;
};

export type EmailLocale = "en" | "vi";

export function normalizeEmailLocale(value: unknown): EmailLocale {
  return typeof value === "string" && value.trim().toLowerCase().startsWith("vi")
    ? "vi"
    : "en";
}

export function escapeEmailHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Email clients fetch logo images outside the app's CSP. Only the configured
 * project's public `salon-imports` Storage object path may cross that boundary;
 * arbitrary HTTPS URLs can act as third-party tracking pixels.
 */
export function normalizeEmailLogoUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > 2_048) return null;
  try {
    const configured = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
    if (!configured) return null;
    const configuredUrl = new URL(configured);
    if (
      configuredUrl.protocol !== "https:" ||
      configuredUrl.username ||
      configuredUrl.password
    ) return null;
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.origin !== configuredUrl.origin ||
      url.search ||
      url.hash
    ) return null;
    const prefix = "/storage/v1/object/public/salon-imports/";
    if (!url.pathname.startsWith(prefix)) return null;
    const objectPath = url.pathname.slice(prefix.length);
    if (!objectPath) return null;
    const segments = objectPath.split("/");
    if (segments.some((segment) => {
      if (!segment) return true;
      try {
        const decoded = decodeURIComponent(segment);
        return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
      } catch {
        return true;
      }
    })) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Pure, shared salon-brand header for individual and group receipts. */
export function buildEmailBrandHeader(input: EmailBrandHeaderInput): string {
  const salonName = input.salonName.trim() || "NailIQ";
  const escapedName = escapeEmailHtml(salonName);
  const escapedSubtitle = escapeEmailHtml(input.subtitle);
  const logoUrl = normalizeEmailLogoUrl(input.logoUrl);
  const nameFallback = `<span style="display:block;margin-top:${logoUrl ? "8px" : "0"};font-size:20px;font-weight:700;color:#D4AF37;letter-spacing:0.04em;">${escapedName}</span>`;
  const identity = logoUrl
    ? `<img src="${escapeEmailHtml(logoUrl)}" alt="${escapedName} logo" width="180" style="display:block;max-width:180px;max-height:72px;width:auto;height:auto;margin:0 auto;border:0;object-fit:contain;" />${nameFallback}`
    : nameFallback;

  return `${identity}
            <p style="margin:6px 0 0;font-size:12px;color:#999;letter-spacing:0.08em;text-transform:uppercase;">${escapedSubtitle}</p>`;
}
