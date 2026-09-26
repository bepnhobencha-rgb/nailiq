import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), limited: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/shared/lib/inAppRateLimit", () => ({ durableRateLimitKey: (...parts: string[]) => parts.join(":"), isOverRateLimit: mocks.limited }));
import { acceptGroupReplacement, loadGroupReplacementPreview, loadGroupSlotRecovery, revokeGroupReplacement, startGroupReplacement } from "../groupSlotRecoveryActions";
const cap = "12345678-1234-4234-8234-123456789012";
const requestId = "12345678-1234-4234-8234-123456789013";
const token = "a".repeat(64);
const expiry = "2099-01-01T00:00:00Z";
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("NAILIQ_GROUP_SLOT_RECOVERY", "true"); vi.stubEnv("NAILIQ_GROUP_SLOT_RECOVERY_WRITES", "true"); mocks.limited.mockResolvedValue(false); });
describe("group replacement server boundary", () => {
  it("OFF returns before rate limit or database", async () => {
    vi.stubEnv("NAILIQ_GROUP_SLOT_RECOVERY", "false");
    expect(await startGroupReplacement({ cancelToken: cap, requestId })).toEqual({ ok: false, code: "feature_disabled" });
    expect(await loadGroupReplacementPreview(token)).toEqual({ ok: false, code: "feature_disabled" });
    expect(await acceptGroupReplacement({token,requestId,name:"Test Guest",phone:"16045550123",consentAccepted:true})).toEqual({ok:false,code:"feature_disabled"});
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.limited).not.toHaveBeenCalled();
  });
  it("write kill-switch preserves receipt reads", async () => {
    vi.stubEnv("NAILIQ_GROUP_SLOT_RECOVERY_WRITES", "false");
    expect(await startGroupReplacement({cancelToken:cap,requestId})).toEqual({ok:false,code:"feature_disabled"});
    expect(await revokeGroupReplacement({cancelToken:cap,requestId})).toEqual({ok:false,code:"feature_disabled"});
    expect(await acceptGroupReplacement({token,requestId,name:"Test Guest",phone:"16045550123",consentAccepted:true})).toEqual({ok:false,code:"feature_disabled"});
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValue({data:{ok:true,state:"accepted",eligible:false,reason:null,expires_at:expiry,timezone:"America/Vancouver"},error:null});
    expect(await loadGroupSlotRecovery(cap)).toMatchObject({ok:true,state:"accepted"});
  });
  it("shared party token cannot authorize a member invite", async () => {
    expect(await startGroupReplacement({ cancelToken: "party-shared", requestId })).toEqual({ ok: false, code: "invalid_input" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("fails closed on rate limit and database/provider-shaped errors", async () => {
    mocks.limited.mockResolvedValueOnce(true);
    expect(await loadGroupSlotRecovery(cap)).toEqual({ ok: false, code: "rate_limited" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "PRIVATE_TOKEN_PII" } });
    expect(await loadGroupSlotRecovery(cap)).toEqual({ ok: false, code: "unavailable" });
    mocks.limited.mockRejectedValueOnce(new Error("PRIVATE_RATE_CONFIG"));
    expect(await revokeGroupReplacement({cancelToken:cap,requestId})).toEqual({ok:false,code:"unavailable"});
  });
  it("response-loss retry reproduces token; database only receives its hash", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, expires_at: expiry, idempotent: false }, error: null });
    const a = await startGroupReplacement({ cancelToken: cap, requestId });
    const b = await startGroupReplacement({ cancelToken: cap.toUpperCase(), requestId });
    expect(a.ok && b.ok && a.token === b.token).toBe(true);
    if (!a.ok) throw new Error("missing result");
    const args = mocks.rpc.mock.calls[0][1];
    expect(args.p_token_hash).toBe(createHash("sha256").update(a.token).digest("hex"));
    expect(JSON.stringify(args)).not.toContain(a.token);
  });
  it("validates receipt before showing success", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, expires_at: "invalid", idempotent: true }, error: null });
    expect(await startGroupReplacement({cancelToken:cap,requestId})).toEqual({ok:false,code:"unavailable"});
    mocks.rpc.mockResolvedValue({data:{ok:true,state:"accepted"},error:null});
    expect(await acceptGroupReplacement({token,requestId,name:"Test Guest",phone:"16045550123",consentAccepted:true})).toEqual({ok:false,code:"unavailable"});
  });
  it("validates consent/contact and canonicalizes new guest phone", async () => {
    const input={token,requestId,name:"Test Guest",phone:"+1 604 555 0123",consentAccepted:false};
    expect(await acceptGroupReplacement(input)).toEqual({ok:false,code:"invalid_input"});
    expect(await acceptGroupReplacement({...input,name:"<script>",consentAccepted:true})).toEqual({ok:false,code:"invalid_input"});
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValue({data:{ok:true,state:"accepted",idempotent:true},error:null});
    expect(await acceptGroupReplacement({...input,consentAccepted:true})).toEqual({ok:true,state:"accepted",idempotent:true});
    expect(mocks.rpc.mock.calls[0][1]).toEqual({p_token_hash:createHash("sha256").update(token).digest("hex"),p_request_id:requestId,p_name:"Test Guest",p_phone:"16045550123",p_consent:true});
  });
  it("preview strips unexpected identity and secrets", async () => {
    mocks.rpc.mockResolvedValue({data:{ok:true,state:"available",salon_name:"QA",service_name:"Service",start_time_utc:expiry,end_time_utc:"2099-01-01T01:00:00Z",timezone:"America/Vancouver",currency:"CAD",price_cents:5000,expires_at:expiry,requires_card:false,client_name:"PRIVATE_ORIGINAL",noshow_card_id:"PRIVATE_CARD"},error:null});
    const result=await loadGroupReplacementPreview(token);
    expect(result.ok).toBe(true); expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
});
