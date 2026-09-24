import { randomUUID } from "node:crypto";
import { cleanupTestSalon, cleanupTestUser, seedTestUser } from "../../e2e/helpers/db";
import { seedReceptionistCenterFixture, supabaseAdmin } from "../../e2e/receptionist-center/helpers";
import { seedReadOnlyLoyalty, cleanupReadOnlyLoyalty } from "../day6/loyalty-fixture";

async function main() {
  const role = process.argv[2] === "owner" ? "owner" : "receptionist";
  if (process.env.NEXT_PUBLIC_SUPABASE_URL !== "http://127.0.0.1:54321"
    || process.env.NAILIQ_DISPOSABLE_DB !== "1"
    || ["DISABLE_OUTBOUND_SMS", "DISABLE_OUTBOUND_EMAIL", "DISABLE_OUTBOUND_CALLS"].some(k => process.env[k] !== "1")
    || !process.stdin.isTTY) throw new Error("Manual fixture requires local QA and private TTY input");
  async function privateLine(): Promise<string> {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return new Promise(resolve => {
      let value = "";
      const listener = (chunk: Buffer) => {
        value += chunk.toString();
        if (/[\r\n]/.test(value)) {
          process.stdin.off("data", listener);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          resolve(value.split(/[\r\n]/)[0]!);
        }
      };
      process.stdin.on("data", listener);
    });
  }
  const slug = `e2e-${role === "owner" ? "day6" : "day5"}-manual-${randomUUID()}`;
  let user: Awaited<ReturnType<typeof seedTestUser>> | undefined;
  let loyaltySalonId: string | undefined;
  let restoreLoyalty: (() => Promise<void>) | undefined;
  const profileId = randomUUID();
  const directoryProfiles = role === "owner" ? Array.from({ length: 52 }, (_, index) => ({
    id: randomUUID(), name: `Te2eGuestDirectory${String(index + 1).padStart(3, "0")}`,
    phone: `1604555${String(2000 + index)}`,
  })) : [];
  console.log("Enter ephemeral synthetic password (input hidden; never saved):");
  const password = await privateLine();
  if (password.length < 24) throw new Error("Use a fresh random password of at least 24 characters");
  try {
    const fx = await seedReceptionistCenterFixture(slug);
    if (role === "owner" && process.argv[3] === "loyalty") {
      loyaltySalonId = fx.salonId;
      restoreLoyalty = await seedReadOnlyLoyalty(fx.salonId);
    }
    if (role === "owner") {
      const phone = "16045550147";
      const name = "Te2eGuestDaySixManual";
      const profile = await supabaseAdmin.from("client_profiles").insert({ id: profileId, phone, name });
      if (profile.error) throw new Error(profile.error.code);
      const booking = await supabaseAdmin.from("bookings").update({ client_name: name, client_phone: phone, addon_price_cents: 1000 })
        .eq("salon_id", fx.salonId).eq("status", "completed");
      if (booking.error) throw new Error(booking.error.code);
      const directory = await supabaseAdmin.from("client_profiles").insert(directoryProfiles);
      if (directory.error) throw new Error(directory.error.code);
      const links = await supabaseAdmin.from("salon_clients").insert(directoryProfiles.map(row => ({
        salon_id: fx.salonId, client_profile_id: row.id, source: "manual",
      })));
      if (links.error) throw new Error(links.error.code);
    }
    user = await seedTestUser({ password });
    const grant = await supabaseAdmin.from("salon_members").insert({ salon_id: fx.salonId, user_id: user.userId, role });
    if (grant.error) throw new Error(grant.error.code);
    console.log(JSON.stringify({ email: user.email, slug, date: fx.ymdUtc, role }));
    console.log("Enter inspect to read synthetic booking state; finish to remove this fixture:");
    while (await privateLine() === "inspect") {
      const rows = await supabaseAdmin.from("bookings").select("client_name,source,status,start_time_utc,staff_id").eq("salon_id", fx.salonId);
      if (rows.error) throw new Error(rows.error.code);
      console.log(JSON.stringify(rows.data));
    }
  } finally {
    if (user) await cleanupTestUser(user.userId);
    try { if (loyaltySalonId) await cleanupReadOnlyLoyalty(loyaltySalonId); }
    finally { await restoreLoyalty?.(); }
    await cleanupTestSalon(slug, { clearAllRateLimits: false });
    if (role === "owner") {
      const profile = await supabaseAdmin.from("client_profiles").delete().in("id", [profileId, ...directoryProfiles.map(row => row.id)]);
      if (profile.error) throw new Error(profile.error.code);
    }
    const remaining = await supabaseAdmin.from("salons").select("id", { count: "exact", head: true }).eq("slug", slug);
    if (remaining.error || remaining.count !== 0) throw new Error("Manual fixture cleanup not proven");
    console.log("Manual fixture removed; salon count=0.");
  }
}
void main();
