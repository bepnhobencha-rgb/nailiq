import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read(
  "supabase/migrations/20260822222042_balance_salon_resource_booked_minutes.sql",
);
const rehearsal = read(
  "scripts/security/rehearse-chair-resource-balancing.sql",
);

describe("MQA-0177 chair/resource balancing boundary", () => {
  it("scores booked minutes only inside one salon-local day", () => {
    expect(migration).toContain("b.salon_id = p_salon_id");
    expect(migration).toContain("seg.salon_id = p_salon_id");
    expect(migration).toContain("p_local_day::timestamp AT TIME ZONE p_timezone");
    expect(migration).toContain("b.schedule_model = 'single'");
    expect(migration).toContain("b.status NOT IN ('cancelled', 'no_show')");
    expect(migration).toContain(
      "seg.reservation_status NOT IN ('cancelled', 'no_show')",
    );
  });

  it("patches only the three audited auto-resource tie-breaks and fails closed on drift", () => {
    expect(migration).toContain("v_match_count <> 3");
    expect(migration).toContain("resource balancing patch verification failed");
    expect(migration).toContain(
      "v_timezone, v_lines, v_exclude_booking_id",
    );
    expect(migration).toContain(
      ") ASC, r.display_order ASC, r.id LIMIT 1",
    );
  });

  it("proves availability, explicit preference, conflict rejection, and stable ties", () => {
    expect(rehearsal).toContain("availability-first balanced allocation failed");
    expect(rehearsal).toContain("explicit chair preference was overridden");
    expect(rehearsal).toContain("occupied explicit chair was not rejected");
    expect(rehearsal).toContain("stable display-order tie-break failed");
    expect(rehearsal).toContain("ROLLBACK");
  });

  it("contains no AI, provider, outbound, or production side effect", () => {
    for (const forbidden of [
      "openai",
      "anthropic",
      "twilio",
      "resend",
      "provider",
      "send_sms",
      "send_email",
      "http_post",
    ]) {
      expect(`${migration}\n${rehearsal}`.toLowerCase()).not.toContain(forbidden);
    }
  });
});
