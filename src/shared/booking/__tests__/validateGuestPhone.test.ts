import { validateGuestPhone } from "../validateGuestPhone";

let pass = 0,
  fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}`);
    console.error(e);
  }
}
function assertEqual(actual: unknown, expected: unknown, msg?: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${msg ?? ""}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

test("CA local 10-digit → +1 normalized", () => {
  assertEqual(validateGuestPhone("6041234567"), {
    ok: true,
    digits: "16041234567",
  });
});

test("CA E.164", () => {
  assertEqual(validateGuestPhone("+1 778 868 0738"), {
    ok: true,
    digits: "17788680738",
  });
});

test("VN E.164 still accepted", () => {
  assertEqual(validateGuestPhone("+84 90 123 4567"), {
    ok: true,
    digits: "84901234567",
  });
});

test("US E.164 (NANP) accepted", () => {
  assertEqual(validateGuestPhone("+1 555 555 0142"), {
    ok: true,
    digits: "15555550142",
  });
});

test("rejects junk and short numbers", () => {
  assertEqual(validateGuestPhone("abc"), { ok: false });
  assertEqual(validateGuestPhone(""), { ok: false });
  assertEqual(validateGuestPhone("123"), { ok: false });
  assertEqual(validateGuestPhone("+++"), { ok: false });
});

test("rejects impossible NANP (1-prefix area code)", () => {
  assertEqual(validateGuestPhone("1234567890"), { ok: false });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
