import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { cleanupTestSalon, cleanupTestUser, seedTestSalon, seedTestSalonMember } from "./helpers/db";
import { supabaseAdmin as db } from "./receptionist-center/helpers";

const slug = "e2e-settings-deep-preflight";
const cards = [
  { id: "sms-template-experience-card", read: "getSmsTemplateSettings", save: "saveSmsTemplateSettings" },
  { id: "customer-channel-card", read: "getCustomerChannelSettings", save: "saveCustomerChannelSettings" },
  { id: "staff-notifications-card", read: "getStaffNotificationSettings", save: "saveStaffNotificationSettings" },
  { id: "owner-notifications-card", read: "getOwnerNotificationSettings", save: "saveOwnerNotificationSettings" },
] as const;
const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")) as { node: Record<string, { exportedName?: string }> };
function actionId(name: string) {
  const id = Object.entries(manifest.node).find(([,v]) => v.exportedName === name)?.[0];
  if (!id) throw new Error(`Missing local build action: ${name}`);
  return id;
}
let salonId: string;
let user: Awaited<ReturnType<typeof seedTestSalonMember>>;
async function login(page: Page) {
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute("data-hydrated", "true");
  await page.locator('input[inputmode="email"]').fill(user.email);
  await page.locator('input[type="password"]').fill(user.password);
  await page.getByTestId("password-signin-submit").click();
  await expect(page).toHaveURL(/\/dashboard\//);
}
async function errors(page: Page) {
  return page.evaluate(() => (window as typeof window & { __qaErrors: string[] }).__qaErrors);
}
test.beforeEach(async ({ page }, info) => {
  ({salonId} = await seedTestSalon({ slug, name: "E2E Settings Deep Preflight", phone: "16045550168" }));
  user = await seedTestSalonMember(salonId, "owner");
  await page.addInitScript((language) => {
    if (!location.protocol.startsWith("http")) return;
    localStorage.setItem("nailiq-user-lang", language);
    const state = window as typeof window & { __qaErrors: string[] };
    state.__qaErrors = [];
    window.addEventListener("error", e => state.__qaErrors.push(e.message));
    window.addEventListener("unhandledrejection", e => state.__qaErrors.push(String(e.reason)));
  }, info.title.includes("[EN]") ? "en" : "vi");
  await login(page);
});
test.afterEach(async ({ page }) => {
  await page.context().setOffline(false);
  await page.goto("about:blank");
  await cleanupTestSalon(slug);
  if (user) await cleanupTestUser(user.userId);
});

for (const card of cards) {
  for (const failure of ["transport", "returned-error"] as const) {
    test(`${card.id}: initial ${failure} must not expose default values for saving`, async ({page}, info) => {
      await page.addInitScript(({id, failure}) => {
        const original = window.fetch.bind(window);
        let injected = false;
        window.fetch = async (input, init) => {
          const request = new Request(input, init);
          if (!injected && request.headers.get("next-action") === id) {
            injected = true;
            if (failure === "transport") throw new TypeError("QA initial read disconnected");
            const response = await original(input, init);
            const body = await response.text();
            if (!body.includes('"ok":true')) throw new Error("QA read-response shape changed");
            return new Response(body.replace('"ok":true', '"ok":false'), {status: response.status, headers: response.headers});
          }
          return original(input, init);
        };
      }, {id: actionId(card.read), failure});
      await page.goto(`/dashboard/${slug}/settings?section=notifications`);
      const section = page.getByTestId(card.id);
      await expect(section.getByRole("alert")).toContainText("Chưa tải được");
      await expect(section.getByRole("button", {name: /^(Lưu|Lưu cài đặt mẫu)$/})).toHaveCount(0);
      await section.screenshot({path: info.outputPath("load-failure.png")});
      await section.getByRole("button", {name: "Thử tải lại"}).click();
      await expect(section.getByRole("button", {name: /^(Lưu|Lưu cài đặt mẫu)$/})).toBeEnabled();
      await expect(section.getByRole("alert")).toHaveCount(0);
      if (card.id === "customer-channel-card") {
        await expect(section.getByTestId("sms-outbound-toggle")).not.toBeChecked();
        await expect(section.getByTestId("email-outbound-toggle")).not.toBeChecked();
      }
      expect(await errors(page)).toEqual([]);
    });
  }
  test(`${card.id}: pending save locks draft until server acknowledgement`, async ({page}) => {
    await page.goto(`/dashboard/${slug}/settings?section=notifications`);
    const section = page.getByTestId(card.id);
    const save = section.getByRole("button", {name: /^(Lưu|Lưu cài đặt mẫu)$/});
    await expect(save).toBeEnabled();
    if (card.id === "owner-notifications-card") {
      await section.getByTestId("owner-notif-enabled").check();
      await section.getByTestId("owner-notif-emails").fill("qa-preflight@example.invalid");
    }
    await page.evaluate(({id}) => {
      const original = window.fetch.bind(window);
      const state = window as typeof window & { __releaseSave?: () => void; __saveHeld?: boolean };
      window.fetch = async (input, init) => {
        const response = await original(input, init);
        if (new Request(input, init).headers.get("next-action") === id) {
          await response.clone().text();
          state.__saveHeld = true;
          await new Promise<void>(resolve => { state.__releaseSave = resolve; });
        }
        return response;
      };
    }, {id: actionId(card.save)});
    await save.click();
    await expect.poll(() => page.evaluate(() => (window as typeof window & {__saveHeld?:boolean}).__saveHeld)).toBe(true);
    try {
      await expect(save).toBeDisabled();
      const inputs = section.locator(card.id === "sms-template-experience-card"
        ? "button[role=switch]" // SMS preview radios do not change saved settings.
        : "input, select, textarea");
      expect(await inputs.count()).toBeGreaterThan(0);
      for (const input of await inputs.all()) await expect(input).toBeDisabled();
    } finally {
      await page.evaluate(() => (window as typeof window & {__releaseSave?:()=>void}).__releaseSave?.());
    }
    await expect(save).toBeEnabled();
    await expect(section.getByRole("status")).toContainText("Đã lưu");
    expect(await errors(page)).toEqual([]);
  });
}

for (const committed of [false,true]) {
  test(`group settings save: ${committed ? "response lost after commit" : "offline before commit"}`, async ({page}) => {
    await page.goto(`/dashboard/${slug}/settings?section=booking`);
    const input = page.getByRole("spinbutton", {name:"Số giờ tuỳ chỉnh"});
    await expect(input).toBeVisible();
    await input.fill("12");
    const save = page.getByRole("button", {name:"Lưu cài đặt",exact:true});
    if (committed) {
      await page.evaluate(({id}) => {
        const original = window.fetch.bind(window);
        let failed = false;
        window.fetch = async (input,init) => {
          const response = await original(input,init);
          if (!failed && new Request(input,init).headers.get("next-action")===id) {
            failed=true; await response.clone().text(); throw new TypeError("QA response lost after group save");
          }
          return response;
        };
      }, {id:actionId("saveGroupBookingSettings")});
    } else await page.context().setOffline(true);
    await save.click();
    await expect(page.getByRole("alert").filter({hasText:"Chưa xác nhận được kết quả lưu"})).toBeVisible();
    await expect(input).toHaveValue("12");
    const beforeRetry=await db.from("salons").select("group_decline_cutoff_hours").eq("id",salonId).single();
    expect(beforeRetry.error).toBeNull();
    expect(beforeRetry.data!.group_decline_cutoff_hours).toBe(committed?12:2);
    await page.context().setOffline(false);
    await save.click();
    await expect(page.getByRole("status").filter({hasText:"Đã lưu!"})).toBeVisible();
    expect(await errors(page)).toEqual([]);
  });
}

const mutationInputs: Record<string,unknown> = {
  saveSmsTemplateSettings: { reminder_24h:false },
  saveCustomerChannelSettings: { smsOutboundEnabled:false, emailOutboundEnabled:false, customerChannel:"email_only" },
  saveStaffNotificationSettings: { enabled:true, defaultLocale:"vi", channels:{sms:false,email:false}, eventDefaults:{create:true,reschedule:true,cancel:true} },
  saveOwnerNotificationSettings: { enabled:true, customEmails:["qa-preflight@example.invalid"] },
  saveGroupBookingSettings: { declineCutoffHours:12 },
};
async function invoke(page: Page, name: string, target: string, input?:unknown) {
  const result = await page.evaluate(async ({id,target,input,hasInput}) => {
    const response = await fetch(`/dashboard/${target}/settings`, {
      method:"POST", redirect:"manual", headers:{"next-action":id,"content-type":"text/plain;charset=UTF-8","accept":"text/x-component"},
      body:JSON.stringify(hasInput?[target,input]:[target]),
    });
    return {type:response.type, text:await response.text()};
  }, {id:actionId(name),target,input,hasInput:input!==undefined});
  // The production middleware rejects signed-out/revoked users before the
  // action runs. A manual redirect is an opaque redirect in browser fetch.
  if (result.type === "opaqueredirect") return {ok:false, blockedBy:"middleware"};
  const results = result.text.split("\n").flatMap(line => {
    const match=line.match(/^[\da-f]+:(\{.*\})$/);
    if (!match) return [];
    try { const value=JSON.parse(match[1]);return typeof value.ok === "boolean" ? [value] : []; } catch {return [];}
  });
  expect(results,`${name} must return a parsed action result`).toHaveLength(1);
  return results[0] as {ok:boolean};
}
async function snapshot() {
  const s=await db.from("salons").select("customer_channel,sms_outbound_enabled,email_outbound_enabled,staff_notification_settings,owner_notification_settings,default_notification_locale,group_decline_cutoff_hours").eq("id",salonId).single();
  const sms=await db.from("salon_sms_template_settings").select("settings").eq("salon_id",salonId).maybeSingle();
  expect(s.error).toBeNull();expect(sms.error).toBeNull();return {salon:s.data,sms:sms.data};
}
for (const role of ["owner","admin","receptionist","senior","nail_tech","revoked","signed-out"] as const) {
  test(`server permissions: ${role} cannot bypass role or tenant boundary`, async ({page}) => {
    const before = await snapshot();
    if (role === "revoked") {
      const r=await db.from("salon_members").delete().eq("salon_id",salonId).eq("user_id",user.userId);expect(r.error).toBeNull();
    } else if (role === "signed-out") {
      await page.context().clearCookies();
      // A fabricated demo cookie must not grant write access in this release rehearsal.
      await page.context().addCookies([{name:"nailiq-demo-slug",value:slug,domain:"localhost",path:"/"}]);
    } else {
      const r=await db.from("salon_members").update({role}).eq("salon_id",salonId).eq("user_id",user.userId);expect(r.error).toBeNull();
    }
    const allowed=role==="owner"||role==="admin";
    for (const name of [...cards.map(c=>c.read),"loadGroupBookingSettings"]) {
      expect((await invoke(page,name,slug)).ok, name).toBe(allowed);
    }
    for (const [name,input] of Object.entries(mutationInputs)) {
      expect((await invoke(page,name,slug,input)).ok,name).toBe(allowed);
    }
    if (!allowed) expect(await snapshot()).toEqual(before);
    else {
      const current=await snapshot();
      expect(current.salon?.customer_channel).toBe("email_only");
      expect(current.salon?.default_notification_locale).toBe("vi");
      expect(current.salon?.group_decline_cutoff_hours).toBe(12);
      expect(current.sms?.settings?.reminder_24h).toBe(false);
    }
    const foreignSlug=`${slug}-foreign`;
    const other=await seedTestSalon({slug:foreignSlug,name:"E2E Foreign Settings",phone:"16045550169"});
    try {
      for (const [name,input] of Object.entries(mutationInputs)) expect((await invoke(page,name,foreignSlug,input)).ok).toBe(false);
      for (const name of [...cards.map(c=>c.read),"loadGroupBookingSettings"]) expect((await invoke(page,name,foreignSlug)).ok).toBe(false);
      const r=await db.from("salons").select("customer_channel,group_decline_cutoff_hours,sms_outbound_enabled,email_outbound_enabled").eq("id",other.salonId).single();
      expect(r.error).toBeNull();expect(r.data?.customer_channel).not.toBe("email_only");expect(r.data?.group_decline_cutoff_hours).toBe(2);
      expect(r.data?.sms_outbound_enabled).toBe(false);expect(r.data?.email_outbound_enabled).toBe(false);
    } finally {await cleanupTestSalon(foreignSlug);}
  });
}


test("[EN] read recovery and uncertain-save copy remain usable without outbound effects", async ({page}, info) => {
  await page.addInitScript(({ids}) => {
    const original=window.fetch.bind(window);
    const failed=new Set<string>();
    window.fetch=async (input,init) => {
      const id=new Request(input,init).headers.get("next-action") || "";
      if (ids.includes(id) && !failed.has(id)) {failed.add(id);throw new TypeError("QA initial English read disconnected");}
      return original(input,init);
    };
  }, {ids:cards.map(card=>actionId(card.read))});
  await page.goto(`/dashboard/${slug}/settings?section=notifications`);
  for (const card of cards) {
    const section=page.getByTestId(card.id);
    await expect(section.getByRole("alert")).toContainText("Settings could not be loaded");
    await section.getByRole("button",{name:"Try loading again"}).click();
    await expect(section.getByRole("button",{name:/^(Save|Save template settings)$/})).toBeEnabled();
  }
  await page.context().setOffline(true);
  for (const card of cards) {
    const section=page.getByTestId(card.id);
    await section.getByRole("button",{name:/^(Save|Save template settings)$/}).click();
    await expect(section.getByRole("alert")).toContainText("The save result could not be confirmed");
  }
  await page.context().setOffline(false);
  for (const card of cards) {
    const section=page.getByTestId(card.id);
    await section.getByRole("button",{name:/^(Save|Save template settings)$/}).click();
    await expect(section.getByRole("status").filter({hasText:"Saved."})).toBeVisible();
  }
  const row=await db.from("salons").select("sms_outbound_enabled,email_outbound_enabled").eq("id",salonId).single();
  expect(row.error).toBeNull();expect(row.data).toEqual({sms_outbound_enabled:false,email_outbound_enabled:false});
  for (const table of ["owner_notification_log","booking_payment_operations"]) {
    const result=await db.from(table).select("id").eq("salon_id",salonId);
    expect(result.error).toBeNull();expect(result.data).toEqual([]);
  }
  expect(await errors(page)).toEqual([]);
  await page.getByTestId("customer-channel-card").screenshot({path:info.outputPath("english-saved.png")});
});

test("role downgraded while form is open refuses save, retains draft, and recovers after authorization", async ({page}) => {
  await page.goto(`/dashboard/${slug}/settings?section=notifications`);
  const section=page.getByTestId("customer-channel-card");
  const save=section.getByRole("button",{name:"Lưu",exact:true});
  await expect(save).toBeEnabled();
  await section.getByTestId("channel-mode-email_only").check();
  const before=await snapshot();
  const revoked=await db.from("salon_members").update({role:"nail_tech"}).eq("salon_id",salonId).eq("user_id",user.userId);
  expect(revoked.error).toBeNull();
  await save.click();
  await expect(section.getByRole("alert")).toContainText("Lưu thất bại");
  await expect(section.getByTestId("channel-mode-email_only")).toBeChecked();
  await expect(save).toBeEnabled();
  expect(await snapshot()).toEqual(before);
  const restored=await db.from("salon_members").update({role:"owner"}).eq("salon_id",salonId).eq("user_id",user.userId);
  expect(restored.error).toBeNull();
  await save.click();
  await expect(section.getByRole("status")).toContainText("Đã lưu.");
  expect((await snapshot()).salon?.customer_channel).toBe("email_only");
  expect(await errors(page)).toEqual([]);
});

for (const failure of ["transport", "returned-error"] as const) {
  test(`[EN] tax settings: initial ${failure} blocks empty defaults and retries saved values`, async ({ page }) => {
    const seeded = await db.from("salons").update({ tax_lines: [{ name: "QA tax", rate: 0.05, enabled: true }] }).eq("id", salonId);
    expect(seeded.error).toBeNull();
    await page.addInitScript(({ id, failure }) => {
      const original = window.fetch.bind(window);
      let injected = false;
      window.fetch = async (input, init) => {
        if (!injected && new Request(input, init).headers.get("next-action") === id) {
          injected = true;
          if (failure === "transport") throw new TypeError("QA tax read disconnected");
          const response = await original(input, init);
          const body = await response.text();
          if (!body.includes('"ok":true')) throw new Error("QA tax response shape changed");
          return new Response(body.replace('"ok":true', '"ok":false'), { status: response.status, headers: response.headers });
        }
        return original(input, init);
      };
    }, { id: actionId("loadTaxSettings"), failure });
    await page.goto(`/dashboard/${slug}/settings?section=booking`);
    await expect(page.getByRole("alert").filter({ hasText: "Tax settings could not be loaded" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save tax settings", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Try loading tax settings again" }).click();
    await expect(page.getByPlaceholder("Tax name (e.g. GST)")).toHaveValue("QA tax");
    await expect(page.getByRole("spinbutton", { name: "Rate %", exact: true })).toHaveValue("5");
    expect(await errors(page)).toEqual([]);
  });
}
