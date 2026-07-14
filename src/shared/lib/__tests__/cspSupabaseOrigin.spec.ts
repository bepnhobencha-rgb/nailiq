import { describe, expect, it } from "vitest";

import { supabaseConnectSrc } from "../../../../next.config";

/**
 * This function builds part of a Content-Security-Policy from an environment
 * variable, which is exactly the shape of thing that turns into a finding if
 * nobody pins it down. So both directions are pinned here:
 *
 *   1. it lets the browser reach the Supabase this build is configured against
 *      — without that, a local stack is silently unreachable and the app shows a
 *      catch-all error with no clue why (it cost this audit a wrong conclusion);
 *   2. it never widens the policy beyond that one origin, and never emits
 *      anything that could break out of the directive.
 *
 * The second block is the one to read twice.
 */
describe("supabaseConnectSrc — allows exactly the configured Supabase", () => {
  it("adds the production project origin (and its websocket)", () => {
    expect(supabaseConnectSrc("https://fshmobzyjhmtvndobwsy.supabase.co")).toEqual([
      "https://fshmobzyjhmtvndobwsy.supabase.co",
      "wss://fshmobzyjhmtvndobwsy.supabase.co",
    ]);
  });

  it("adds the local stack origin (and its websocket)", () => {
    // Realtime needs ws:// on the same origin; without it the receptionist board
    // would stop updating live under a local stack.
    expect(supabaseConnectSrc("http://127.0.0.1:54321")).toEqual([
      "http://127.0.0.1:54321",
      "ws://127.0.0.1:54321",
    ]);
  });

  it("keeps the port — a bare host would not match 127.0.0.1:54321", () => {
    expect(supabaseConnectSrc("http://localhost:54321")).toEqual([
      "http://localhost:54321",
      "ws://localhost:54321",
    ]);
  });

  it("drops the path, query and fragment — an origin is scheme://host:port", () => {
    expect(supabaseConnectSrc("https://abc.supabase.co/rest/v1?x=1#y")).toEqual([
      "https://abc.supabase.co",
      "wss://abc.supabase.co",
    ]);
  });
});

describe("supabaseConnectSrc — never widens the policy", () => {
  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["not a URL", "not-a-url"],
    ["a bare host", "abc.supabase.co"],
    ["data: URL (origin would be the literal 'null')", "data:text/html,<x>"],
    ["javascript: URL", "javascript:alert(1)"],
    ["file: URL", "file:///etc/passwd"],
    ["ftp: URL", "ftp://example.com"],
  ])("emits nothing for %s", (_label, input) => {
    expect(supabaseConnectSrc(input as string | undefined)).toEqual([]);
  });

  it.each([
    ["http:", "https://abc.supabase.co"],
    ["https:", "https://abc.supabase.co"],
    ["*", "https://abc.supabase.co"],
    ["ws:", "http://127.0.0.1:54321"],
    ["wss:", "https://abc.supabase.co"],
    ["'unsafe-inline'", "https://abc.supabase.co"],
  ])("never emits the bare wildcard %s", (forbidden, input) => {
    expect(supabaseConnectSrc(input)).not.toContain(forbidden);
  });

  it("cannot inject a second CSP directive", () => {
    // The safety property in one test. A URL's `origin` is scheme://host[:port]
    // and cannot contain a space or a semicolon, so a value like this collapses
    // to a harmless origin rather than smuggling `script-src *` into the header.
    const hostile = "https://evil.example/; script-src * 'unsafe-inline'";
    const out = supabaseConnectSrc(hostile);
    expect(out).toEqual(["https://evil.example", "wss://evil.example"]);
    for (const entry of out) {
      expect(entry).not.toContain(";");
      expect(entry).not.toContain(" ");
      expect(entry).not.toContain("script-src");
    }
  });

  it("emits at most the one origin and its websocket — never more", () => {
    expect(supabaseConnectSrc("https://abc.supabase.co")).toHaveLength(2);
  });
});
