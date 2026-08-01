import { describe, expect, it } from "vitest";

import { appRedirects } from "../../../../next.config";

describe("dashboard legacy redirects", () => {
  it("moves Reports to Insights before the App Router renders", () => {
    expect(appRedirects()).toContainEqual({
      source: "/dashboard/:slug/reports",
      destination: "/dashboard/:slug/insights",
      permanent: false,
    });
  });
});
