import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("MQA-0175 grounded upsell boundary", () => {
  it("validates the exact OTP capability before any history or salon read and only surfaces a claimed offer", () => {
    const route = read("src/app/api/upsell/route.ts");
    const validation = route.indexOf('"validate_phone_otp_session"');
    const firstTableRead = route.indexOf("db\n    .from(");
    const claim = route.indexOf('"claim_ai_upsell_offer"');
    const returnOffer = route.lastIndexOf("return response(payload)");

    expect(validation).toBeGreaterThan(-1);
    expect(firstTableRead).toBeGreaterThan(validation);
    expect(claim).toBeGreaterThan(firstTableRead);
    expect(returnOffer).toBeGreaterThan(claim);
    expect(route).toContain("p_salon_id: salonId");
    expect(route).toContain("p_phone: phoneDigits");
    expect(route).toContain('.eq("is_addon", true)');
    expect(route).toContain('.is("deleted_at", null)');
    expect(route).not.toContain('.from("ai_upsell_log")');
    expect(route).not.toContain("crypto.randomUUID()");
    expect(route).not.toContain('.from("bookings").insert');
    expect(route).not.toMatch(/square|stripe|twilio|openai/i);
    expect(route).toContain('claimOutcome !== "claimed" && claimOutcome !== "replayed"');
    expect(route).toContain('"Cache-Control": "private, no-store"');
  });

  it("uses a forced-RLS service-only immutable claim keyed by the exact salon/session", () => {
    const migration = read(
      "supabase/migrations/20260823012836_add_atomic_upsell_session_claim.sql",
    );

    expect(migration).toContain("unique (salon_id, session_id)");
    expect(migration).toContain("on conflict (salon_id, session_id) do nothing");
    expect(migration).toContain("where existing.salon_id = p_salon_id");
    expect(migration).toContain("and existing.session_id = p_session_id");
    expect(migration).toContain("force row level security");
    expect(migration).toContain("from public, anon, authenticated, service_role");
    expect(migration).toContain("grant select, insert on table public.ai_upsell_session_claims to service_role");
    expect(migration).toContain(") to service_role;");
    expect(migration).toContain("ai_upsell_session_claim_is_immutable");
    expect(migration).toContain("capability_fingerprint");
    expect(migration).toContain("offer_material_fingerprint");
    expect(migration).toContain("elsif v_existing.phone_fingerprint <> v_phone_fingerprint");
    expect(migration).toContain("'capability_mismatch'::text");
    expect(migration).toContain("'offer_material_mismatch'::text");
    expect(migration).toContain("A committed claim is the durable receipt");
    expect(migration.indexOf("A committed claim is the durable receipt"))
      .toBeLessThan(migration.indexOf("Both selected and suggested services"));
  });

  it("stores no raw customer identity or bearer capability in the immutable claim", () => {
    const migration = read(
      "supabase/migrations/20260823012836_add_atomic_upsell_session_claim.sql",
    );
    const tableDefinition = migration.slice(
      migration.indexOf("create table public.ai_upsell_session_claims"),
      migration.indexOf("comment on table public.ai_upsell_session_claims"),
    );

    expect(tableDefinition).toContain("phone_fingerprint text not null");
    expect(tableDefinition).toContain("capability_fingerprint text not null");
    expect(tableDefinition).toContain("offer_payload - array[");
    expect(tableDefinition).toContain("= '{}'::jsonb");
    expect(tableDefinition).not.toMatch(/client_phone|phone text|email|customer_name|otp_session_id/);
    expect(migration).toContain("Compatibility-only PII write");
    expect(migration).toContain("insert into public.ai_upsell_log");
    expect(migration.match(/insert into public\.ai_upsell_log/g)).toHaveLength(1);
  });

  it("does not accept browser-authored revenue or accepted outcomes", () => {
    const route = read("src/app/api/upsell/outcome/route.ts");

    expect(route).toContain("isSameOriginMutation(req)");
    expect(route).toContain('new Set(["dismissed", "ignored", "timeout"])');
    expect(route).toContain("body.added_revenue_cents !== undefined");
    expect(route).toContain('"validate_phone_otp_session"');
    expect(route).toContain('.eq("salon_id", salonId)');
    expect(route).toContain('.eq("client_phone", phoneResult.digits)');
  });

  it("does not let the voice model self-assert an accepted outcome", () => {
    const tools = read("src/shared/voiceai/realtimeTools.ts");
    const executor = read("src/shared/voiceai/toolExecutor.ts");

    expect(tools).not.toContain("upsell_accepted");
    expect(executor).not.toContain("args.upsell_accepted");
    expect(executor).not.toContain("upsellAccepted");
  });

  it("loads only non-deleted menu services and keeps both prompts optional and grounded", () => {
    const context = read("src/shared/voiceai/loadSalonContext.ts");
    const phone = read("src/shared/voiceai/buildPhoneSystemPrompt.ts");
    const web = read("src/shared/voiceai/buildSystemPrompt.ts");

    expect(context).toContain('.is("deleted_at", null)');
    expect(context).not.toContain('.eq("is_active", true)');
    for (const prompt of [phone, web]) {
      expect(prompt).toContain("matching non-empty category or explicit salon_details");
      expect(prompt).toContain("exact Menu price label and total duration");
      expect(prompt).toContain("added price/time only when both current and candidate fixed Menu values");
      expect(prompt).toContain("get_available_slots AGAIN");
      expect(prompt).not.toContain("lasts two to three weeks");
    }
    expect(phone).toContain("at most once");
    expect(web).toContain("AT MOST ONCE");
  });
});
