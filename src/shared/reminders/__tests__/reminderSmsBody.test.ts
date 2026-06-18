// Direct smoke test — run with: npx tsx src/shared/reminders/__tests__/reminderSmsBody.test.ts
// Verifies the reminder SMS body renders correctly in both Vietnamese and English,
// and that an AI lead line still gets a localised footer.

import { reminderLang, buildReminderSmsBody } from "../reminderSmsBody";

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}

// --- reminderLang resolution ---
console.log("\n[reminderLang]");
check('"vi" → vi', reminderLang("vi") === "vi");
check('"vi-VN" → vi', reminderLang("vi-VN") === "vi");
check('"en" → en', reminderLang("en") === "en");
check("null → en (safe default)", reminderLang(null) === "en");
check("undefined → en", reminderLang(undefined) === "en");

// --- Vietnamese 24h ---
const vi24 = buildReminderSmsBody({
  lang: "vi",
  reminderType: "24h",
  serviceName: "Hi Lite Classic",
  salonName: "Hi-Lite Head Spa",
  timeLabel: "9:00 AM",
  confirmUrl: "https://nailiq.ca/c/abc",
  rescheduleUrl: "https://nailiq.ca/r/abc",
});
console.log("\n[VI · nhắc 24h]\n" + vi24 + "\n");
check("VI có 'Nhắc lịch:'", vi24.includes("Nhắc lịch:"));
check("VI có 'vào ngày mai'", vi24.includes("vào ngày mai"));
check("VI có 'Xác nhận:'", vi24.includes("Xác nhận:"));
check("VI có 'Đổi lịch:'", vi24.includes("Đổi lịch:"));
check("VI có 'Nhắn STOP để huỷ nhận tin.'", vi24.includes("Nhắn STOP để huỷ nhận tin."));
check("VI không lẫn tiếng Anh ('Reply STOP')", !vi24.includes("Reply STOP"));

// --- Vietnamese 3h ---
const vi3 = buildReminderSmsBody({
  lang: "vi",
  reminderType: "3h",
  serviceName: "Hi Lite Deluxe",
  salonName: "Hi-Lite Head Spa",
  timeLabel: "2:30 PM",
  confirmUrl: "https://nailiq.ca/c/xyz",
  rescheduleUrl: "https://nailiq.ca/r/xyz",
});
console.log("[VI · nhắc 3h]\n" + vi3 + "\n");
check("VI 3h có 'trong 3 giờ nữa'", vi3.includes("trong 3 giờ nữa"));

// --- English 24h (unchanged default) ---
const en24 = buildReminderSmsBody({
  lang: "en",
  reminderType: "24h",
  serviceName: "Hi Lite Classic",
  salonName: "Hi-Lite Head Spa",
  timeLabel: "9:00 AM",
  confirmUrl: "https://nailiq.ca/c/abc",
  rescheduleUrl: "https://nailiq.ca/r/abc",
});
console.log("[EN · reminder 24h]\n" + en24 + "\n");
check("EN có 'Reminder:'", en24.includes("Reminder:"));
check("EN có 'tomorrow'", en24.includes("tomorrow"));
check("EN có 'Reply STOP to opt out.'", en24.includes("Reply STOP to opt out."));

// --- English 3h ---
const en3 = buildReminderSmsBody({
  lang: "en",
  reminderType: "3h",
  serviceName: "Hi Lite Deluxe",
  salonName: "Hi-Lite Head Spa",
  timeLabel: "2:30 PM",
  confirmUrl: "https://nailiq.ca/c/xyz",
  rescheduleUrl: "https://nailiq.ca/r/xyz",
});
check("EN 3h có 'in 3 hours'", en3.includes("in 3 hours"));

// --- AI lead override still gets a localised footer ---
const viAi = buildReminderSmsBody({
  lang: "vi",
  reminderType: "24h",
  serviceName: "Hi Lite Classic",
  salonName: "Hi-Lite Head Spa",
  timeLabel: "9:00 AM",
  confirmUrl: "https://nailiq.ca/c/abc",
  rescheduleUrl: "https://nailiq.ca/r/abc",
  aiLead: "Chào Sarah, mai gặp bạn lúc 9 giờ sáng nhé!",
});
console.log("[VI · AI lead]\n" + viAi + "\n");
check("AI lead được dùng làm câu mở", viAi.startsWith("Chào Sarah"));
check("AI lead vẫn có footer VI 'Nhắn STOP'", viAi.includes("Nhắn STOP để huỷ nhận tin."));

// --- empty service falls back gracefully ---
const viNoService = buildReminderSmsBody({
  lang: "vi",
  reminderType: "24h",
  serviceName: "",
  salonName: "Hi-Lite Head Spa",
  timeLabel: "9:00 AM",
  confirmUrl: "https://nailiq.ca/c/abc",
  rescheduleUrl: "https://nailiq.ca/r/abc",
});
check("VI service rỗng → fallback 'lịch hẹn'", viNoService.includes("lịch hẹn"));

console.log(`\n${failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAIL`}`);
process.exit(failures === 0 ? 0 : 1);
