/**
 * Unit tests for staffNotificationSettings parser + defaults.
 *
 * Run: npx tsx src/shared/dashboard/__tests__/staffNotificationSettings.test.ts
 */

import {
  parseStaffNotificationSettings,
  defaultNotifyOn,
  DEFAULT_STAFF_NOTIFICATION_SETTINGS,
} from "../staffNotificationSettings";

let pass = 0,
  fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}
function eq(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// Null / junk → defaults (panel on, en, smart per-event).
test("null → defaults", () => {
  eq(parseStaffNotificationSettings(null), DEFAULT_STAFF_NOTIFICATION_SETTINGS);
});
test("default smart per-event: guest-impacting events ON, no_show OFF", () => {
  const d = DEFAULT_STAFF_NOTIFICATION_SETTINGS;
  eq(d.eventDefaults, {
    create: true,
    reschedule: true,
    cancel: true,
    no_show: false,
    staff_change: true,
  });
  eq(d.defaultLocale, "en");
});

// Partial JSON merges with defaults.
test("partial events merge with defaults", () => {
  const s = parseStaffNotificationSettings({
    eventDefaults: { cancel: false },
  });
  eq(s.eventDefaults.cancel, false);
  eq(s.eventDefaults.reschedule, true); // untouched default
  eq(s.eventDefaults.no_show, false);
  eq(s.eventDefaults.staff_change, true);
});
test("enabled defaults true, explicit false respected", () => {
  eq(parseStaffNotificationSettings({}).enabled, true);
  eq(parseStaffNotificationSettings({ enabled: false }).enabled, false);
});
test("defaultLocale normalized; junk → en", () => {
  eq(
    parseStaffNotificationSettings({ defaultLocale: "vi" }).defaultLocale,
    "vi",
  );
  eq(
    parseStaffNotificationSettings({ defaultLocale: "fr" }).defaultLocale,
    "en",
  );
});
test("saved salon locale is the fallback when notification JSON is missing", () => {
  eq(parseStaffNotificationSettings(null, "vi").defaultLocale, "vi");
  eq(parseStaffNotificationSettings({}, "vi").defaultLocale, "vi");
  eq(
    parseStaffNotificationSettings({ defaultLocale: "en" }, "vi").defaultLocale,
    "en",
  );
});
test("channels parsed, missing channel → default true", () => {
  const s = parseStaffNotificationSettings({ channels: { sms: false } });
  eq(s.channels.sms, false);
  eq(s.channels.email, true);
});

// defaultNotifyOn respects master switch.
test("defaultNotifyOn false when feature disabled", () => {
  const s = parseStaffNotificationSettings({ enabled: false });
  eq(defaultNotifyOn(s, "cancel"), false);
});
test("defaultNotifyOn true for cancel by default", () => {
  eq(defaultNotifyOn(parseStaffNotificationSettings(null), "cancel"), true);
  eq(defaultNotifyOn(parseStaffNotificationSettings(null), "no_show"), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
