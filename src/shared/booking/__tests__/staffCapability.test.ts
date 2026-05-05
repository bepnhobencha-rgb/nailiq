import {
  buildCapabilityMap,
  filterStaffCapableForService,
  filterStaffCapableForServices,
  isStaffCapableForService,
} from "../staffCapability";

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

test("empty rows → null map (all-capable fallback)", () => {
  assertEqual(buildCapabilityMap([]), null);
  assertEqual(buildCapabilityMap(null), null);
});

test("isStaffCapableForService returns true for null map", () => {
  assertEqual(isStaffCapableForService(null, "s1", "svc1"), true);
});

test("isStaffCapableForService respects whitelist when populated", () => {
  const cap = buildCapabilityMap([
    { staff_id: "s1", service_id: "svc1" },
    { staff_id: "s1", service_id: "svc2" },
    { staff_id: "s2", service_id: "svc1" },
  ]);
  assertEqual(isStaffCapableForService(cap, "s1", "svc1"), true);
  assertEqual(isStaffCapableForService(cap, "s1", "svc2"), true);
  assertEqual(isStaffCapableForService(cap, "s1", "svc3"), false);
  assertEqual(isStaffCapableForService(cap, "s2", "svc2"), false);
  /* Staff with zero rows in a populated salon == "can't perform anything." */
  assertEqual(isStaffCapableForService(cap, "s3", "svc1"), false);
});

test("filterStaffCapableForService — fallback returns full list", () => {
  const staff = [{ id: "s1" }, { id: "s2" }];
  assertEqual(filterStaffCapableForService(staff, null, "svc1"), staff);
});

test("filterStaffCapableForService — narrows to whitelist", () => {
  const cap = buildCapabilityMap([{ staff_id: "s1", service_id: "svc1" }]);
  const out = filterStaffCapableForService(
    [{ id: "s1" }, { id: "s2" }],
    cap,
    "svc1",
  );
  assertEqual(out, [{ id: "s1" }]);
});

test("filterStaffCapableForServices — must satisfy every service in the bundle", () => {
  const cap = buildCapabilityMap([
    { staff_id: "s1", service_id: "svc1" },
    { staff_id: "s1", service_id: "svc2" },
    { staff_id: "s2", service_id: "svc1" },
  ]);
  const out = filterStaffCapableForServices(
    [{ id: "s1" }, { id: "s2" }],
    cap,
    ["svc1", "svc2"],
  );
  assertEqual(out, [{ id: "s1" }]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
