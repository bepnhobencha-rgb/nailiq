import { assertNotProductionFromEnv } from "../e2e/helpers/guardProduction";

assertNotProductionFromEnv();
console.log("✓ guard: not production");
