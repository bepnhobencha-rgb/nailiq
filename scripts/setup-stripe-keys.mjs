#!/usr/bin/env node
/**
 * setup-stripe-keys.mjs
 * ---------------------------------------------------------------------------
 * Tool interactive để nhập / cập nhật Stripe keys vào .env.local một cách an
 * toàn, rồi verify keys có khớp account NailIQ không.
 *
 * Cách chạy (tại thư mục repo nailiq):
 *     node scripts/setup-stripe-keys.mjs
 *
 * - Keys bạn paste chỉ ghi vào .env.local trên máy bạn (không gửi đi đâu).
 * - Script gọi Stripe API bằng secret key NGAY TRÊN MÁY bạn để xác nhận
 *   account name + charges_enabled. Secret key không rời khỏi máy.
 * - Các key khác trong .env.local được giữ nguyên, chỉ cập nhật Stripe keys.
 * ---------------------------------------------------------------------------
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import https from "node:https";

const ENV_PATH = resolve(process.cwd(), ".env.local");

const STRIPE_KEYS = [
  {
    name: "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
    label: "Publishable key  (pk_live_... hoặc pk_test_...)",
    prefixes: ["pk_live_", "pk_test_"],
    optional: false,
  },
  {
    name: "STRIPE_SECRET_KEY",
    label: "Secret key       (sk_live_... hoặc sk_test_...)",
    prefixes: ["sk_live_", "sk_test_", "rk_live_", "rk_test_"],
    optional: false,
  },
  {
    name: "STRIPE_WEBHOOK_SECRET",
    label: "Webhook secret   (whsec_...)",
    prefixes: ["whsec_"],
    optional: true,
  },
  {
    name: "STRIPE_PRICE_PRO",
    label: "Price ID gói Pro (price_...) — bỏ trống nếu chưa tạo",
    prefixes: ["price_"],
    optional: true,
  },
  {
    name: "STRIPE_PRICE_PREMIUM",
    label: "Price ID Premium (price_...) — bỏ trống nếu chưa tạo",
    prefixes: ["price_"],
    optional: true,
  },
];

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

function mask(value) {
  if (!value) return "(trống)";
  if (value.length <= 12) return value.slice(0, 4) + "…";
  return value.slice(0, 12) + "…" + value.slice(-4);
}

/** Parse .env.local thành mảng dòng + map key→index để cập nhật tại chỗ. */
function readEnv() {
  if (!existsSync(ENV_PATH)) {
    console.error(`${C.red}Không tìm thấy .env.local tại ${ENV_PATH}${C.reset}`);
    console.error("Chạy script này tại thư mục gốc repo nailiq.");
    process.exit(1);
  }
  const raw = readFileSync(ENV_PATH, "utf8");
  return raw.split("\n");
}

function getValue(lines, key) {
  const re = new RegExp(`^${key}=(.*)$`);
  for (const line of lines) {
    const m = line.match(re);
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, "");
  }
  return "";
}

function setValue(lines, key, value) {
  const re = new RegExp(`^${key}=`);
  const newLine = `${key}="${value}"`;
  const idx = lines.findIndex((l) => re.test(l));
  if (idx >= 0) lines[idx] = newLine;
  else lines.push(newLine);
  return lines;
}

/** Gọi Stripe API /v1/account bằng secret key (chạy local). */
function getStripeAccount(secretKey) {
  return new Promise((resolve2, reject) => {
    const req = https.request(
      "https://api.stripe.com/v1/account",
      { method: "GET", headers: { Authorization: `Bearer ${secretKey}` } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve2({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve2({ status: res.statusCode, body: null });
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("Timeout gọi Stripe API")));
    req.end();
  });
}

async function main() {
  console.log(`\n${C.bold}${C.cyan}🔑 Stripe Keys Setup — NailIQ${C.reset}`);
  console.log(`${C.dim}Cập nhật Stripe keys trong .env.local + verify account.${C.reset}\n`);

  const lines = readEnv();
  const rl = createInterface({ input, output });

  for (const k of STRIPE_KEYS) {
    const current = getValue(lines, k.name);
    const currentLabel = current ? `${C.green}${mask(current)}${C.reset}` : `${C.yellow}(trống)${C.reset}`;
    console.log(`${C.bold}${k.name}${C.reset}`);
    console.log(`  ${k.label}`);
    console.log(`  Hiện tại: ${currentLabel}`);

    let answer = await rl.question(`  Paste value mới (Enter để giữ nguyên): `);
    answer = answer.trim();

    if (!answer) {
      if (!current && !k.optional) {
        console.log(`  ${C.yellow}⚠ Để trống — key bắt buộc này vẫn chưa có.${C.reset}\n`);
      } else {
        console.log(`  ${C.dim}→ giữ nguyên.${C.reset}\n`);
      }
      continue;
    }

    const okPrefix = k.prefixes.some((p) => answer.startsWith(p));
    if (!okPrefix) {
      console.log(
        `  ${C.red}✗ Sai định dạng. Phải bắt đầu bằng: ${k.prefixes.join(" / ")}${C.reset}`,
      );
      console.log(`  ${C.dim}→ bỏ qua key này, chạy lại để nhập đúng.${C.reset}\n`);
      continue;
    }

    setValue(lines, k.name, answer);
    console.log(`  ${C.green}✓ Đã cập nhật → ${mask(answer)}${C.reset}\n`);
  }

  // Ghi lại .env.local
  writeFileSync(ENV_PATH, lines.join("\n"), "utf8");
  console.log(`${C.green}${C.bold}✓ Đã lưu .env.local${C.reset}\n`);

  // Verify bằng Stripe API
  const secret = getValue(lines, "STRIPE_SECRET_KEY");
  const pub = getValue(lines, "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY");

  if (!secret) {
    console.log(`${C.yellow}⚠ Chưa có STRIPE_SECRET_KEY → không verify được account.${C.reset}`);
    rl.close();
    return;
  }

  // Cảnh báo nếu publishable & secret lệch live/test
  const secretMode = secret.includes("_live_") ? "live" : secret.includes("_test_") ? "test" : "?";
  const pubMode = pub.includes("_live_") ? "live" : pub.includes("_test_") ? "test" : "?";
  if (pub && secretMode !== pubMode) {
    console.log(
      `${C.red}⚠ LỆCH MODE: publishable=${pubMode}, secret=${secretMode}. Phải cùng live HOẶC cùng test!${C.reset}\n`,
    );
  }

  console.log(`${C.dim}Đang gọi Stripe API verify account...${C.reset}`);
  try {
    const { status, body } = await getStripeAccount(secret);
    if (status === 200 && body) {
      console.log(`\n${C.green}${C.bold}✓ Secret key hợp lệ — account:${C.reset}`);
      console.log(`  Account ID:       ${C.cyan}${body.id}${C.reset}`);
      console.log(`  Business name:    ${body.business_profile?.name || body.settings?.dashboard?.display_name || "(chưa đặt)"}`);
      console.log(`  Country:          ${body.country}`);
      console.log(`  Mode:             ${secretMode}`);
      console.log(`  charges_enabled:  ${body.charges_enabled ? C.green + "true (thu tiền được)" : C.yellow + "false (chưa verify xong KYC)"}${C.reset}`);
      console.log(`  payouts_enabled:  ${body.payouts_enabled ? C.green + "true" : C.yellow + "false"}${C.reset}`);
      const dn = (body.settings?.dashboard?.display_name || body.business_profile?.name || "").toLowerCase();
      if (dn.includes("nailiq") || dn.includes("nail")) {
        console.log(`\n  ${C.green}✓ Có vẻ đúng account NailIQ.${C.reset}`);
      } else {
        console.log(`\n  ${C.yellow}⚠ Account name không chứa "NailIQ" — kiểm tra lại có đúng account mới không.${C.reset}`);
      }
    } else {
      console.log(`\n${C.red}✗ Secret key không hợp lệ (HTTP ${status}).${C.reset}`);
      console.log(`  ${body?.error?.message || "Kiểm tra lại secret key."}`);
    }
  } catch (e) {
    console.log(`\n${C.red}✗ Lỗi gọi Stripe API: ${e.message}${C.reset}`);
  }

  console.log(`\n${C.dim}Xong. Nhớ: env mới chỉ áp dụng sau khi restart "npm run dev" (xoá .next nếu cần).${C.reset}`);
  console.log(`${C.dim}Để cập nhật trên production: thêm cùng các key này vào Vercel → Settings → Environment Variables → Production, rồi redeploy.${C.reset}\n`);

  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
