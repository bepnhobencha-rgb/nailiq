import { describe, expect, it } from "vitest";
import {
  isPrivateOrReservedIp,
  parseSafeHttpUrl,
} from "../../../../supabase/functions/_shared/safeOutboundFetch";

describe("website importer outbound URL guard", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])("blocks private/reserved address %s", (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "allows public address %s",
    (ip) => expect(isPrivateOrReservedIp(ip)).toBe(false),
  );

  it.each([
    "http://localhost/admin",
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "ftp://example.com/file",
    "https://user:secret@example.com/",
    "https://example.com:8443/",
    "http://[::1]/",
  ])("rejects unsafe URL %s", (url) => {
    expect(() => parseSafeHttpUrl(url)).toThrow();
  });

  it("accepts an ordinary public website URL", () => {
    expect(parseSafeHttpUrl("https://example.com/salon").href).toBe(
      "https://example.com/salon",
    );
  });
});
