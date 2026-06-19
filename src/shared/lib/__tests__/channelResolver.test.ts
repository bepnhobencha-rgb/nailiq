/**
 * Unit tests for resolveCustomerChannel — covering the A2P 10DLC guardrail
 * and backwards-compatibility for callers that don't pass A2P params.
 *
 * Run with:  npx tsx src/shared/lib/__tests__/channelResolver.test.ts
 */

import { resolveCustomerChannel } from "../channelResolver";

function assertEqual<T>(actual: T, expected: T, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${msg ?? "assertEqual failed"}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

// ─── A2P 10DLC guardrail — US + not registered ────────────────────────────────

// US number + smsA2pRegistered=false + has email → email fallback, no SMS
{
  const result = resolveCustomerChannel({
    mode: "smart",
    smsOutboundEnabled: true,
    emailOutboundEnabled: true,
    customerEmail: "test@example.com",
    smsA2pRegistered: false,
    customerPhone: "+12125551234", // US (NYC)
  });
  assertEqual(result.sms, false, "US + not registered: sms must be false");
  assertEqual(result.email, true, "US + not registered + has email: email must be true");
  assertEqual(result.noChannel, false, "US + not registered + has email: noChannel must be false");
  assertEqual(result.reason, "email_a2p_fallback", "reason must be email_a2p_fallback");
}

// US number + smsA2pRegistered=false + no email → noChannel
{
  const result = resolveCustomerChannel({
    mode: "smart",
    smsOutboundEnabled: true,
    emailOutboundEnabled: true,
    customerEmail: null,
    smsA2pRegistered: false,
    customerPhone: "+12125551234",
  });
  assertEqual(result.sms, false, "US + not registered + no email: sms must be false");
  assertEqual(result.email, false, "US + not registered + no email: email must be false");
  assertEqual(result.noChannel, true, "US + not registered + no email: noChannel must be true");
}

// ─── Non-US numbers — A2P flag is irrelevant ─────────────────────────────────

// Canadian number: A2P=false must NOT block SMS
{
  const result = resolveCustomerChannel({
    mode: "smart",
    smsOutboundEnabled: true,
    emailOutboundEnabled: true,
    customerEmail: "ca@example.com",
    smsA2pRegistered: false,
    customerPhone: "+16045551234", // CA (Vancouver)
  });
  assertEqual(result.sms, true, "CA number + not registered: sms must still be true");
}

// Vietnamese number: A2P=false must NOT block SMS
{
  const result = resolveCustomerChannel({
    mode: "smart",
    smsOutboundEnabled: true,
    emailOutboundEnabled: true,
    customerEmail: "vn@example.com",
    smsA2pRegistered: false,
    customerPhone: "+84901234567", // VN
  });
  assertEqual(result.sms, true, "VN number + not registered: sms must still be true");
}

// ─── US number with A2P=true ──────────────────────────────────────────────────

{
  const result = resolveCustomerChannel({
    mode: "smart",
    smsOutboundEnabled: true,
    emailOutboundEnabled: true,
    customerEmail: "test@example.com",
    smsA2pRegistered: true,
    customerPhone: "+12125551234",
  });
  assertEqual(result.sms, true, "US + registered (smsA2pRegistered=true): sms must be true");
  assertEqual(result.noChannel, false, "US + registered: noChannel must be false");
}

// ─── Back-compat: no A2P params passed ──────────────────────────────────────

// smsA2pRegistered omitted → undefined → treated as registered (back-compat)
{
  const result = resolveCustomerChannel({
    mode: "smart",
    smsOutboundEnabled: true,
    emailOutboundEnabled: true,
    customerEmail: "test@example.com",
    customerPhone: "+12125551234",
    // smsA2pRegistered intentionally omitted
  });
  assertEqual(result.sms, true, "back-compat (no smsA2pRegistered): sms must be true");
}

// No A2P params at all → original behaviour preserved
{
  const result = resolveCustomerChannel({
    mode: "smart",
    smsOutboundEnabled: true,
    emailOutboundEnabled: true,
    customerEmail: "test@example.com",
  });
  assertEqual(result.sms, true, "back-compat (no A2P params): sms must be true");
  assertEqual(result.email, true, "back-compat (no A2P params): email must be true");
}

// ─── Modes + A2P interaction ──────────────────────────────────────────────────

// sms_only + US + not registered → noChannel (no email fallback in sms_only mode)
{
  const result = resolveCustomerChannel({
    mode: "sms_only",
    smsOutboundEnabled: true,
    emailOutboundEnabled: true,
    customerEmail: "test@example.com",
    smsA2pRegistered: false,
    customerPhone: "+12125551234",
  });
  assertEqual(result.sms, false, "sms_only + US + not registered: sms must be false");
  assertEqual(result.email, false, "sms_only + US + not registered: email must be false (mode=sms_only)");
  assertEqual(result.noChannel, true, "sms_only + US + not registered: noChannel must be true");
}

// email_only — A2P is irrelevant (never touches SMS path)
{
  const result = resolveCustomerChannel({
    mode: "email_only",
    smsOutboundEnabled: true,
    emailOutboundEnabled: true,
    customerEmail: "test@example.com",
    smsA2pRegistered: false,
    customerPhone: "+12125551234",
  });
  assertEqual(result.sms, false, "email_only: sms must be false regardless");
  assertEqual(result.email, true, "email_only: email must be true");
  assertEqual(result.noChannel, false, "email_only + has email: noChannel must be false");
}

// sms_and_email + US + not registered → email true, sms false, no noChannel
{
  const result = resolveCustomerChannel({
    mode: "sms_and_email",
    smsOutboundEnabled: true,
    emailOutboundEnabled: true,
    customerEmail: "test@example.com",
    smsA2pRegistered: false,
    customerPhone: "+12125551234",
  });
  assertEqual(result.sms, false, "sms_and_email + US + not registered: sms must be false");
  assertEqual(result.email, true, "sms_and_email + US + not registered: email must be true");
  assertEqual(result.noChannel, false, "sms_and_email + US + not registered + has email: noChannel must be false");
}

console.log("✓ channelResolver — all A2P guardrail tests passed");
