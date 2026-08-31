import "server-only";
import { randomBytes } from "node:crypto";
import { buildEmailBrandHeader } from "@/shared/booking/emailBranding";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";
import {
  complianceFooterHtml,
  listUnsubscribeHeaders,
  isEmailSuppressed,
} from "@/shared/lib/emailCompliance";
import { emailExperienceTags } from "@/shared/lib/emailExperienceRegistry";

/**
 * Re-opt-in campaign for Square-imported customers.
 *
 * These customers only ever consented to marketing via Square, never to NailIQ,
 * so `client_profiles.marketing_consent_at` is null and Minh's care agents are
 * (correctly) blocked from emailing them. This campaign asks them to confirm —
 * clicking the email CTA hits `/r/<token>`, which stamps marketing_consent_at
 * (full opt-in) and drops them into the booking flow with a 10%-off voucher
 * pre-applied. Booking is the claim; the consent is the by-product.
 *
 * Nothing here fires a customer email until an operator explicitly runs the
 * batch (POST /api/reoptin/run) — and a dry-run / test-send path exists so the
 * copy can be reviewed before any real send.
 */

const DISCOUNT_PERCENT = 10;
const VOUCHER_VALID_DAYS = 45;
const SEND_GAP_MS = 120; // gentle spacing between Resend sends

export type ReoptinClient = {
  id: string;
  name: string | null;
  email: string;
  phone: string | null;
};

type SalonRow = {
  id: string;
  slug: string;
  name: string;
  email: string | null;
  address: string | null;
};

function origin(): string {
  const base =
    (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  return (base || "https://nailiq.ca").replace(/\/$/, "");
}

function genToken(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * Sender that reads as the salon, kept on the verified platform address so it
 * still lands in the inbox: "NailIQ <hello@nailiq.ca>" -> "Hi-Lite Head Spa
 * <hello@nailiq.ca>". Replies still go to the salon (replyTo). Falls back to the
 * raw env value if it carries no <address>.
 */
function brandedFrom(salonName: string): string {
  const raw = getResendFrom();
  const m = raw.match(/<([^>]+)>/);
  const addr = m ? m[1] : raw;
  const name = salonName.replace(/[<>"]/g, "").trim();
  return name ? `${name} <${addr}>` : raw;
}

function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c),
  );
}

/** First name only, for a friendly greeting. Falls back to a neutral hello. */
function firstName(name: string | null): string | null {
  const n = (name ?? "").trim();
  if (!n) return null;
  return esc(n.split(/\s+/)[0]);
}

async function loadSalon(slug: string): Promise<SalonRow | null> {
  const db = createServiceRoleClient();
  const { data } = await db
    .from("salons" as never)
    .select("id, slug, name, email, address")
    .eq("slug" as never, slug)
    .maybeSingle();
  return (data as SalonRow | null) ?? null;
}

/**
 * Candidates: clients of this salon that have an email, have NOT given NailIQ
 * marketing consent yet, aren't soft-deleted, and haven't already been sent a
 * re-opt-in. Highest lifetime spend first, so a capped pilot naturally targets
 * the most valuable customers.
 */
export async function loadTargets(
  salonId: string,
  limit: number,
): Promise<ReoptinClient[]> {
  const db = createServiceRoleClient();

  // Clients already sent — exclude (idempotency across runs).
  const { data: sent } = await db
    .from("reoptin_sends" as never)
    .select("client_profile_id")
    .eq("salon_id" as never, salonId);
  const already = new Set(
    ((sent ?? []) as { client_profile_id: string }[]).map((r) => r.client_profile_id),
  );

  // Salon membership + spend ordering.
  const { data: links } = await db
    .from("salon_clients" as never)
    .select("client_profile_id")
    .eq("salon_id" as never, salonId);
  const ids = Array.from(
    new Set(
      ((links ?? []) as { client_profile_id: string }[])
        .map((r) => r.client_profile_id)
        .filter((id) => !already.has(id)),
    ),
  );
  if (ids.length === 0) return [];

  // Spend, to rank highest-value first.
  const { data: spendRows } = await db
    .from("salon_client_spend" as never)
    .select("client_profile_id, total_spend_cents")
    .eq("salon_id" as never, salonId);
  const spend = new Map<string, number>(
    ((spendRows ?? []) as { client_profile_id: string; total_spend_cents: number }[]).map(
      (r) => [r.client_profile_id, Number(r.total_spend_cents) || 0],
    ),
  );

  // Profiles (chunk the IN list to stay under URL limits).
  const out: ReoptinClient[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const { data: profs } = await db
      .from("client_profiles" as never)
      .select("id, name, email, phone, marketing_consent_at, deleted_at")
      .in("id" as never, chunk);
    for (const p of (profs ?? []) as {
      id: string;
      name: string | null;
      email: string | null;
      phone: string | null;
      marketing_consent_at: string | null;
      deleted_at: string | null;
    }[]) {
      if (p.deleted_at) continue;
      if (p.marketing_consent_at) continue; // already opted in
      const email = (p.email ?? "").trim();
      if (!email || !email.includes("@")) continue;
      out.push({ id: p.id, name: p.name, email, phone: p.phone });
    }
  }

  out.sort((a, b) => (spend.get(b.id) ?? 0) - (spend.get(a.id) ?? 0));
  return out.slice(0, Math.max(0, limit));
}

export type CampaignStats = {
  eligible: number; // customers who could still be sent
  sent: number; // ledger rows that reached the customer
  confirmed: number; // opted in (clicked the CTA)
  booked: number; // opted in AND booked
};

/**
 * Dashboard summary for the re-opt-in campaign: how many customers remain
 * eligible, and how the already-sent ledger has progressed (sent → confirmed →
 * booked). Uses the service-role client (the ledger has no anon/auth RLS).
 */
export async function loadCampaignStats(salonId: string): Promise<CampaignStats> {
  const db = createServiceRoleClient();
  const { data } = await db
    .from("reoptin_sends" as never)
    .select("status, confirmed_at, booked_at")
    .eq("salon_id" as never, salonId);
  const rows = (data ?? []) as {
    status: string;
    confirmed_at: string | null;
    booked_at: string | null;
  }[];
  const sent = rows.filter((r) =>
    ["sent", "confirmed", "booked"].includes(r.status),
  ).length;
  const confirmed = rows.filter((r) => !!r.confirmed_at).length;
  const booked = rows.filter((r) => !!r.booked_at).length;
  const eligible = (await loadTargets(salonId, 1_000_000)).length;
  return { eligible, sent, confirmed, booked };
}

/**
 * Get-or-create this client's re-opt-in voucher. Idempotent: a re-run reuses the
 * existing row (and its code) rather than minting a second one.
 */
export async function ensureVoucher(
  salonId: string,
  client: ReoptinClient,
): Promise<{ voucherId: string; code: string } | null> {
  const db = createServiceRoleClient();

  const { data: existing } = await db
    .from("vouchers" as never)
    .select("id, code")
    .eq("salon_id" as never, salonId)
    .eq("client_profile_id" as never, client.id)
    .eq("kind" as never, "reoptin")
    .is("revoked_at" as never, null)
    .maybeSingle();
  if (existing) {
    const e = existing as { id: string; code: string };
    return { voucherId: e.id, code: e.code };
  }

  const now = new Date();
  const expires = new Date(now.getTime() + VOUCHER_VALID_DAYS * 864e5);
  const canonicalPhone = client.phone ? toCanonicalPhone(client.phone) : null;

  // Unique random code — collisions are astronomically unlikely, but retry once.
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = `KEEP10-${randomBytes(4).toString("hex").toUpperCase().slice(0, 6)}`;
    const { data, error } = await db
      .from("vouchers" as never)
      .insert({
        salon_id: salonId,
        code,
        kind: "reoptin",
        percent_off: DISCOUNT_PERCENT,
        max_uses: 1,
        valid_from: now.toISOString(),
        expires_at: expires.toISOString(),
        client_phone: canonicalPhone,
        client_profile_id: client.id,
      } as never)
      .select("id, code")
      .single();
    if (!error && data) {
      const d = data as { id: string; code: string };
      return { voucherId: d.id, code: d.code };
    }
    const dup = error && /duplicate|unique/i.test(String(error.message ?? error));
    if (!dup) {
      console.error("[reoptin] voucher insert failed", error);
      return null;
    }
  }
  return null;
}

export function renderEmail(opts: {
  client: ReoptinClient;
  salon: SalonRow;
  bookUrl: string;
  code: string;
}): { subject: string; html: string; text: string } {
  const fn = firstName(opts.client.name);
  const greetEn = fn ? `Hi ${fn},` : "Hi there,";
  const greetVi = fn ? `Chào ${fn},` : "Chào bạn,";
  const salonName = esc(opts.salon.name);
  const subject = `${opts.salon.name} has moved — confirm to keep your perks`;

  const btn = (label: string) =>
    `<a href="${opts.bookUrl}" style="display:inline-block;background:#1f3d38;color:#f6f1e6;text-decoration:none;font-size:15px;font-weight:600;padding:14px 34px;border-radius:3px;border:1px solid #16302c;">${label}</a>`;

  const html = `<div style="background:#f4efe6;padding:28px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#fffdf8;border:1px solid #e7dfcd;border-radius:4px;overflow:hidden;">
    <div style="padding:24px 28px;text-align:center;background:#0B0C10;">
      ${buildEmailBrandHeader({ salonName: opts.salon.name, subtitle: "NAILIQ SALON CONCIERGE" })}
    </div>
    <div style="padding:4px 36px 8px;color:#3d3a33;">
      <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:25px;line-height:1.25;font-weight:500;color:#1f3d38;text-align:center;margin:10px 0 20px;">Let's stay in touch.</h1>
      <p style="font-size:15.5px;line-height:1.7;margin:0 0 15px;">${greetEn}</p>
      <p style="font-size:15.5px;line-height:1.7;margin:0 0 15px;">We've upgraded how ${salonName} handles your bookings, appointment reminders, and member offers — it all runs through our new system now.</p>
      <p style="font-size:15.5px;line-height:1.7;margin:0 0 18px;">Want to keep getting reminders and members-only offers? One tap confirms it.</p>
      <div style="background:#f6eeda;border:1px solid #ecdcba;border-radius:6px;padding:15px 20px;text-align:center;margin:0 0 22px;">
        <div style="font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#9c7a44;font-weight:700;margin-bottom:4px;">A little thank-you</div>
        <div style="font-size:15px;color:#4a4236;"><b style="color:#1f3d38;">${DISCOUNT_PERCENT}% off your next visit</b> — applied automatically when you book below.</div>
        <div style="margin-top:9px;padding-top:9px;border-top:1px dashed #e3d4b3;font-size:11.5px;color:#7a7466;">Code <b style="color:#9c7a44;font-family:monospace;">${esc(opts.code)}</b> · yours to reuse if you book later</div>
      </div>
      <div style="text-align:center;margin:0 0 16px;">${btn("Book my visit &amp; save " + DISCOUNT_PERCENT + "%")}</div>
      <p style="text-align:center;font-size:12.5px;color:#7a7466;margin:0 0 6px;">Booking confirms you're in — we'll only send the occasional reminder or offer, never spam.</p>
      <p style="font-size:15px;color:#3d3a33;margin:20px 0 4px;">See you soon,<br><b style="color:#1f3d38;">The ${salonName} team</b></p>
      <div style="display:flex;align-items:center;margin:26px 0 6px;"><div style="flex:1;height:1px;background:#e7dfcd;"></div><div style="padding:0 12px;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#7c9a8d;font-weight:600;">Tiếng Việt</div><div style="flex:1;height:1px;background:#e7dfcd;"></div></div>
      <p style="font-size:14.5px;line-height:1.7;color:#514c41;margin:0 0 12px;">${greetVi} ${salonName} vừa nâng cấp hệ thống đặt lịch, nhắc hẹn và ưu đãi thành viên. Bấm đặt hẹn bên dưới là bạn vừa xác nhận nhận tin, vừa được <b>giảm ${DISCOUNT_PERCENT}%</b> tự động cho lần ghé tới (mã <b style="font-family:monospace;">${esc(opts.code)}</b>).</p>
      <div style="text-align:center;margin:0 0 6px;">${btn("Đặt hẹn &amp; giảm " + DISCOUNT_PERCENT + "%")}</div>
    </div>
    ${complianceFooterHtml({ email: opts.client.email, salonName: opts.salon.name, salonAddress: opts.salon.address, lang: "en" })}
  </div>
</div>`;

  const text = `${greetEn}

We've upgraded how ${opts.salon.name} handles your bookings, reminders, and member offers.

Keep getting reminders and member offers — and get ${DISCOUNT_PERCENT}% off your next visit, applied when you book:
${opts.bookUrl}

Your code: ${opts.code} (valid ${VOUCHER_VALID_DAYS} days).

See you soon, The ${opts.salon.name} team`;

  return { subject, html, text };
}

type SendResult =
  | { status: "sent"; email: string; code: string }
  | { status: "skipped"; email: string; reason: string }
  | { status: "failed"; email: string; reason: string };

async function sendOne(
  salon: SalonRow,
  client: ReoptinClient,
  dryRun: boolean,
): Promise<SendResult> {
  const db = createServiceRoleClient();

  if (await isEmailSuppressed(client.email)) {
    return { status: "skipped", email: client.email, reason: "suppressed" };
  }

  // Get-or-create the ledger row (idempotent on salon+client) and its token.
  const { data: existingSend } = await db
    .from("reoptin_sends" as never)
    .select("id, token, status")
    .eq("salon_id" as never, salon.id)
    .eq("client_profile_id" as never, client.id)
    .maybeSingle();

  let token: string;
  if (existingSend) {
    const e = existingSend as { token: string; status: string };
    if (e.status === "sent" || e.status === "confirmed" || e.status === "booked") {
      return { status: "skipped", email: client.email, reason: "already_sent" };
    }
    token = e.token;
  } else {
    token = genToken();
    const { error } = await db.from("reoptin_sends" as never).insert({
      salon_id: salon.id,
      client_profile_id: client.id,
      email: client.email,
      token,
      status: "pending",
    } as never);
    if (error) {
      // Lost a race (unique salon+client) — treat as already handled.
      return { status: "skipped", email: client.email, reason: "race" };
    }
  }

  const voucher = await ensureVoucher(salon.id, client);
  if (!voucher) return { status: "failed", email: client.email, reason: "voucher" };

  const bookUrl = `${origin()}/r/${token}`;
  const { subject, html, text } = renderEmail({ client, salon, bookUrl, code: voucher.code });

  if (dryRun) {
    return { status: "skipped", email: client.email, reason: "dry_run" };
  }

  const resend = getResendClient();
  if (!resend) return { status: "failed", email: client.email, reason: "no_resend" };

  const { error } = await resend.emails.send({
    from: brandedFrom(salon.name),
    to: client.email,
    subject,
    html,
    text,
    ...(salon.email ? { replyTo: salon.email } : {}),
    headers: listUnsubscribeHeaders(client.email),
    tags: emailExperienceTags("reoptin_campaign"),
  });

  if (error) {
    await db
      .from("reoptin_sends" as never)
      .update({ status: "failed" } as never)
      .eq("token" as never, token);
    return { status: "failed", email: client.email, reason: String(error) };
  }

  await db
    .from("reoptin_sends" as never)
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      voucher_id: voucher.voucherId,
      code: voucher.code,
    } as never)
    .eq("token" as never, token);

  return { status: "sent", email: client.email, code: voucher.code };
}

export type BatchSummary = {
  salon: string;
  targeted: number;
  sent: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  results: SendResult[];
};

/**
 * Run the campaign for one salon. `testTo` sends a single sample email to that
 * address (no DB writes, no voucher) for copy review. `dryRun` walks the real
 * target list and records nothing sendable. Otherwise sends for real, capped by
 * `limit`, highest-spend first.
 */
export async function runReoptinBatch(
  salonSlug: string,
  opts: { limit?: number; dryRun?: boolean; testTo?: string } = {},
): Promise<BatchSummary> {
  const salon = await loadSalon(salonSlug);
  if (!salon) {
    return { salon: salonSlug, targeted: 0, sent: 0, skipped: 0, failed: 0, dryRun: !!opts.dryRun, results: [] };
  }

  // Test send: one sample email, no persistence.
  if (opts.testTo) {
    const sample: ReoptinClient = { id: "test", name: "Melissa", email: opts.testTo, phone: null };
    const bookUrl = `${origin()}/${salon.slug}?code=KEEP10-SAMPLE&ref=reoptin`;
    const { subject, html, text } = renderEmail({ client: sample, salon, bookUrl, code: "KEEP10-SAMPLE" });
    const resend = getResendClient();
    if (!resend) {
      return { salon: salon.slug, targeted: 1, sent: 0, skipped: 0, failed: 1, dryRun: false, results: [{ status: "failed", email: opts.testTo, reason: "no_resend" }] };
    }
    const { error } = await resend.emails.send({
      from: brandedFrom(salon.name),
      to: opts.testTo,
      subject: `[TEST] ${subject}`,
      html,
      text,
      ...(salon.email ? { replyTo: salon.email } : {}),
    });
    const r: SendResult = error
      ? { status: "failed", email: opts.testTo, reason: String(error) }
      : { status: "sent", email: opts.testTo, code: "KEEP10-SAMPLE" };
    return { salon: salon.slug, targeted: 1, sent: error ? 0 : 1, skipped: 0, failed: error ? 1 : 0, dryRun: false, results: [r] };
  }

  const limit = Math.max(0, Math.min(opts.limit ?? 200, 5000));
  const targets = await loadTargets(salon.id, limit);
  const results: SendResult[] = [];
  let sent = 0, skipped = 0, failed = 0;

  for (const client of targets) {
    const r = await sendOne(salon, client, !!opts.dryRun);
    results.push(r);
    if (r.status === "sent") sent++;
    else if (r.status === "skipped") skipped++;
    else failed++;
    if (!opts.dryRun && r.status === "sent") await new Promise((res) => setTimeout(res, SEND_GAP_MS));
  }

  return { salon: salon.slug, targeted: targets.length, sent, skipped, failed, dryRun: !!opts.dryRun, results };
}

/**
 * Confirm a token: stamp full marketing consent, ensure the voucher exists, and
 * return where to send the customer (booking flow with the code pre-applied).
 * Idempotent — clicking twice is harmless.
 */
export async function confirmReoptin(
  token: string,
): Promise<{ ok: true; slug: string; code: string } | { ok: false }> {
  const db = createServiceRoleClient();
  const { data: send } = await db
    .from("reoptin_sends" as never)
    .select("id, salon_id, client_profile_id, code")
    .eq("token" as never, token)
    .maybeSingle();
  if (!send) return { ok: false };
  const s = send as { salon_id: string; client_profile_id: string; code: string | null };

  const salon = await (async () => {
    const { data } = await db
      .from("salons" as never)
      .select("id, slug, name, email, address")
      .eq("id" as never, s.salon_id)
      .maybeSingle();
    return (data as SalonRow | null) ?? null;
  })();
  if (!salon) return { ok: false };

  // Stamp full opt-in (only if not already — don't overwrite an earlier date).
  const { data: prof } = await db
    .from("client_profiles" as never)
    .select("id, name, email, phone, marketing_consent_at")
    .eq("id" as never, s.client_profile_id)
    .maybeSingle();
  if (!prof) return { ok: false };
  const p = prof as {
    id: string; name: string | null; email: string | null; phone: string | null;
    marketing_consent_at: string | null;
  };
  if (!p.marketing_consent_at) {
    await db
      .from("client_profiles" as never)
      .update({ marketing_consent_at: new Date().toISOString() } as never)
      .eq("id" as never, s.client_profile_id);
  }

  const voucher = await ensureVoucher(salon.id, {
    id: p.id, name: p.name, email: p.email ?? "", phone: p.phone,
  });
  const code = voucher?.code ?? s.code ?? "";

  await db
    .from("reoptin_sends" as never)
    .update({
      status: "confirmed",
      confirmed_at: new Date().toISOString(),
      ...(voucher ? { voucher_id: voucher.voucherId, code: voucher.code } : {}),
    } as never)
    .eq("token" as never, token);

  return { ok: true, slug: salon.slug, code };
}
