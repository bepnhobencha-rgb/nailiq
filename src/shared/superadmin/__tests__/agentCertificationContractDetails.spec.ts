import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentCertificationContractDetails } from "@/components/superadmin/AgentCertificationContractDetails";

describe("AgentCertificationContractDetails", () => {
  it("renders every mandatory contract field with an agent-specific disclosure name", () => {
    const html = renderToStaticMarkup(createElement(
      AgentCertificationContractDetails,
      {
        agentLabel: "Win-back",
        contract: {
          trigger: {
            kind: "scheduled",
            summary: "Hourly and consent-gated",
            freshnessHours: 48,
          },
          permissionContract: ["Requires ai_winback=true"],
          inputs: ["Eligible inactive customers"],
          outputs: ["One customer SMS or email"],
          effectLevel: "customer_communication",
          auditContract: ["Only successful send actions qualify"],
          retryPolicy: ["Customer/action deduplication"],
          costPolicy: {
            kind: "mixed",
            summary: "Model and channel cost",
            ledgerFeatures: ["winback_draft"],
          },
          runtimeEvidencePredicate: {
            category: "customer_delivery",
            summary: "A fresh successful send audit exists",
          },
        },
      },
    ));

    expect(html).toContain("<details");
    expect(html).toContain(
      'aria-label="View certification contract for Win-back"',
    );
    for (const label of [
      "Trigger",
      "Effect level",
      "Permission contract",
      "Inputs",
      "Outputs",
      "Audit contract",
      "Retry policy",
      "Cost policy",
      "Runtime evidence predicate",
    ]) {
      expect(html).toContain(label);
    }
  });
});
