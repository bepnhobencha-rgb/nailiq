import { describe, expect, it } from "vitest";

import {
  toOwnerExecutionBlocker,
  toOwnerExecutionJob,
  toOwnerExecutionResult,
  type OwnerExecutionJobSource,
} from "@/shared/ai/executionOwnerView";

function source(
  overrides: Partial<OwnerExecutionJobSource> = {},
): OwnerExecutionJobSource {
  return {
    id: "job-1",
    approval_request_id: "approval-1",
    action_type: "bulk_message",
    status: "waiting_input",
    attempt_count: 1,
    max_attempts: 3,
    last_error: null,
    result: null,
    created_at: "2026-07-30T10:00:00.000Z",
    ...overrides,
  };
}

describe("owner execution view", () => {
  it("copies only the owner contract and removes queue credentials", () => {
    const raw = {
      ...source(),
      salon_id: "salon-secret",
      payload: { recipients: ["private@example.com"] },
      idempotency_key: "idempotency-secret",
      lease_token: "lease-secret",
      lease_expires_at: "2026-07-30T10:05:00.000Z",
      result: {
        blocker: "recipient_selection_required",
        provider_token: "provider-secret",
      },
    };

    const view = toOwnerExecutionJob(raw);
    expect(view).toEqual({
      id: "job-1",
      approval_request_id: "approval-1",
      action_type: "bulk_message",
      status: "waiting_input",
      attempt_count: 1,
      max_attempts: 3,
      last_error: null,
      result: {
        blocker: "recipient_selection_required",
        audience_preparation: null,
        dispatch_preflight: null,
        dispatch_plan: null,
      },
      created_at: "2026-07-30T10:00:00.000Z",
    });
    expect(JSON.stringify(view)).not.toMatch(
      /salon-secret|private@example|idempotency-secret|lease-secret|provider-secret/,
    );
  });

  it("maps raw failure text to a safe owner code", () => {
    const view = toOwnerExecutionJob(
      source({ last_error: "password=secret customer=private@example.com" }),
    );

    expect(view.last_error).toBe("execution_transient_failure");
    expect(JSON.stringify(view)).not.toContain("private@example.com");
  });

  it("allows only known blocker codes", () => {
    expect(toOwnerExecutionBlocker("dispatch_not_enabled")).toBe(
      "dispatch_not_enabled",
    );
    expect(toOwnerExecutionBlocker("database_password=secret")).toBeNull();
  });

  it("allowlists campaign summaries without recipient or manifest details", () => {
    const result = toOwnerExecutionResult({
      blocker: "dispatch_not_enabled",
      audience_preparation: {
        prepared_at: "2026-07-30T10:00:00.000Z",
        eligible_count: 12,
        sms_recipient_count: 8,
        email_recipient_count: 4,
        excluded_no_consent: 2,
        excluded_no_channel: 1,
        excluded_recent_contact: 3,
        estimated_cost_usd_cents: 96,
        candidate_limit: 100,
        may_have_more_candidates: false,
        no_messages_sent: true,
        recipients: ["private@example.com"],
      },
      dispatch_preflight: {
        preflight_at: "2026-07-30T10:00:00.000Z",
        valid_until: "2026-07-30T10:15:00.000Z",
        freshness_minutes: 15,
        preflight_status: "ready",
        eligible_count: 12,
        sms_recipient_count: 8,
        email_recipient_count: 4,
        excluded_recent_contact: 3,
        excluded_no_consent: 2,
        excluded_no_channel: 1,
        excluded_missing_profile: 0,
        excluded_manifest_channel_unavailable: 0,
        estimated_cost_usd_cents: 96,
        recipient_cap: 100,
        cost_cap_usd_cents: 500,
        within_recipient_cap: true,
        within_cost_cap: true,
        dispatch_enabled: false,
        no_messages_sent: true,
        manifest: { customers: ["private@example.com"] },
      },
      dispatch_plan: {
        plan_id: "private-plan-id",
        plan_status: "sealed",
        plan_fingerprint: "private-fingerprint",
        recipient_count: 12,
        sms_recipient_count: 8,
        email_recipient_count: 4,
        estimated_cost_usd_cents: 96,
        expires_at: "2026-07-30T10:15:00.000Z",
        dispatch_enabled: false,
        no_messages_sent: true,
        recipients: ["private@example.com"],
      },
    });

    expect(result).not.toBeNull();
    expect(result?.dispatch_plan).toEqual({
      recipient_count: 12,
      sms_recipient_count: 8,
      email_recipient_count: 4,
      estimated_cost_usd_cents: 96,
      expires_at: "2026-07-30T10:15:00.000Z",
      no_messages_sent: true,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private@example|private-plan-id|private-fingerprint|"manifest":|"recipients":/,
    );
  });

  it("drops malformed or unsafe campaign summaries", () => {
    const result = toOwnerExecutionResult({
      blocker: "internal_stack_trace",
      audience_preparation: {
        eligible_count: -1,
        no_messages_sent: true,
      },
      dispatch_preflight: {
        preflight_status: "ready",
        no_messages_sent: false,
      },
      dispatch_plan: {
        plan_status: "sealed",
        recipient_count: 2,
        no_messages_sent: false,
      },
    });

    expect(result).toEqual({
      blocker: null,
      audience_preparation: null,
      dispatch_preflight: null,
      dispatch_plan: null,
    });
  });
});
