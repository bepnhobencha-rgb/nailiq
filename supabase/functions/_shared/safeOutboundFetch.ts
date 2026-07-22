const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);

declare const Deno: {
  resolveDns(hostname: string, recordType: "A" | "AAAA"): Promise<string[]>;
};

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return octets.reduce((value, part) => (value << 8) + part, 0) >>> 0;
}

function inIpv4Cidr(ip: number, base: string, prefix: number): boolean {
  const baseNumber = ipv4ToNumber(base)!;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) === (baseNumber & mask);
}

export function isPrivateOrReservedIp(rawIp: string): boolean {
  const ip = rawIp.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const ipv4 = ipv4ToNumber(ip);
  if (ipv4 !== null) {
    return [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ].some(([base, prefix]) => inIpv4Cidr(ipv4, base as string, prefix as number));
  }

  if (!ip.includes(":")) return true; // malformed/non-IP values fail closed
  if (ip === "::" || ip === "::1") return true;
  if (ip.startsWith("fc") || ip.startsWith("fd") || /^fe[89ab]/.test(ip)) return true;
  if (ip.startsWith("ff")) return true;
  if (ip.startsWith("2001:db8:")) return true;
  if (ip.startsWith("::ffff:")) {
    return isPrivateOrReservedIp(ip.slice("::ffff:".length));
  }
  return false;
}

export function parseSafeHttpUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("blocked_protocol");
  if (url.username || url.password) throw new Error("blocked_credentials");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("blocked_port");

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
    throw new Error("blocked_hostname");
  }
  if (ipv4ToNumber(hostname) !== null || hostname.includes(":")) {
    if (isPrivateOrReservedIp(hostname)) throw new Error("blocked_ip");
  }
  return url;
}

export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  const url = parseSafeHttpUrl(rawUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (ipv4ToNumber(hostname) !== null || hostname.includes(":")) return url;

  const answers = (
    await Promise.allSettled([
      Deno.resolveDns(hostname, "A"),
      Deno.resolveDns(hostname, "AAAA"),
    ])
  ).flatMap((result) => result.status === "fulfilled" ? result.value : []);

  if (answers.length === 0) throw new Error("dns_resolution_failed");
  if (answers.some(isPrivateOrReservedIp)) throw new Error("blocked_dns_target");
  return url;
}

export async function safeOutboundFetch(
  rawUrl: string,
  init: RequestInit = {},
  maxRedirects = 5,
): Promise<Response> {
  let current = await assertPublicHttpUrl(rawUrl);
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location || redirectCount === maxRedirects) {
      response.body?.cancel();
      throw new Error("redirect_rejected");
    }
    response.body?.cancel();
    current = await assertPublicHttpUrl(new URL(location, current).href);
  }
  throw new Error("too_many_redirects");
}
