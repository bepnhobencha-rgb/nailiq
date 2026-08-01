import { describe, expect, it } from "vitest";

import {
  executionFailureLabel,
  toSafeExecutionFailureCode,
  toSafeWorkerFailureCode,
  workerFailureLabel,
} from "@/shared/ai/executionFailure";

describe("execution failure privacy", () => {
  it("does not persist an unknown provider or database error", () => {
    expect(
      toSafeExecutionFailureCode(
        new Error("password=secret customer=someone@example.com"),
      ),
    ).toBe("execution_transient_failure");
  });

  it("preserves only allowlisted operational codes", () => {
    expect(toSafeExecutionFailureCode("worker_lease_expired")).toBe(
      "worker_lease_expired",
    );
    expect(toSafeExecutionFailureCode("arbitrary_internal_error")).toBe(
      "execution_transient_failure",
    );
  });

  it("never renders a historical raw error to the owner", () => {
    expect(
      executionFailureLabel("password=secret", "en"),
    ).toBe(
      "Execution hit a temporary failure. Technical details remain in secure logs.",
    );
    expect(executionFailureLabel("password=secret", "vi")).not.toContain(
      "secret",
    );
  });

  it("allows only known heartbeat codes and bounded HTTP failures", () => {
    expect(toSafeWorkerFailureCode("manager_agent_failures")).toBe(
      "manager_agent_failures",
    );
    expect(toSafeWorkerFailureCode("http_503")).toBe("http_503");
    expect(
      toSafeWorkerFailureCode(
        "connection failed for customer someone@example.com",
      ),
    ).toBe("execution_worker_failed");
  });

  it("never renders historical raw heartbeat text to the owner", () => {
    expect(
      workerFailureLabel("password=secret", "en"),
    ).toBe(
      "The worker hit an operating failure; technical details remain in secure logs.",
    );
    expect(workerFailureLabel("password=secret", "vi")).not.toContain(
      "secret",
    );
  });
});
