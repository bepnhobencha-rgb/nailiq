import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), active: vi.fn() }));
vi.mock("@/shared/lib/supabase/server", () => ({ createClient: mocks.create }));
vi.mock("@/shared/auth/requireActiveAuthSession", () => ({ requireActiveAuthSession: mocks.active }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
import { loadSalonSessions } from "../presenceActions";
const row = { user_id: "member", salon_id: "salon", last_seen_at: "2026-09-10T00:00:00Z" };
const member = { user_id: "member", role: "owner", name: "QA Owner", email: "qa@example.invalid" };
type Reply = { data: unknown; error: unknown };
function db(replies: Reply[]) {
  const chains: { eq: ReturnType<typeof vi.fn> }[] = [];
  const from = vi.fn(() => {
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected query");
    const chain = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(), gte: vi.fn(), order: vi.fn(), in: vi.fn() };
    chain.select.mockReturnValue(chain); chain.eq.mockReturnValue(chain); chain.gte.mockReturnValue(chain);
    chain.maybeSingle.mockResolvedValue(reply); chain.order.mockResolvedValue(reply); chain.in.mockResolvedValue(reply);
    chains.push(chain); return chain;
  });
  mocks.create.mockResolvedValue({ from }); return { from, chains };
}
const success = (): Reply[] => [
  { data: { id: "salon" }, error: null }, { data: { role: "owner" }, error: null },
  { data: [row], error: null }, { data: [member], error: null },
];
beforeEach(() => { vi.resetAllMocks(); mocks.active.mockResolvedValue({ ok: true, user: { id: "actor" } }); });
describe("presence reads preserve failure and authorization truth", () => {
  for (const stage of [0, 1, 2, 3]) it(`query failure at stage ${stage} never returns empty or fabricated success`, async () => {
    const replies = success(); replies[stage] = { data: null, error: { message: "private DB detail" } };
    const client = db(replies);
    expect(await loadSalonSessions("qa-salon")).toEqual({ ok: false, error: "server_error" });
    expect(client.from).toHaveBeenCalledTimes(stage + 1);
  });
  it("preserves Next navigation control flow", async () => {
    mocks.create.mockImplementation(() => redirect("/login"));
    await expect(loadSalonSessions("qa-salon")).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
  });
  it("missing salon is a denial, not a successful empty list", async () => {
    const client = db([{ data: null, error: null }]);
    expect(await loadSalonSessions("qa-salon")).toEqual({ ok: false, error: "not_found" });
    expect(client.from).toHaveBeenCalledTimes(1);
  });
  it("unexpected transport rejection returns a safe retryable result", async () => {
    mocks.create.mockRejectedValue(new Error("private network detail"));
    await expect(loadSalonSessions("qa-salon")).resolves.toEqual({ ok: false, error: "server_error" });
  });
  for (const code of ["unauthenticated", "session_revoked", "auth_unavailable"]) it(`auth ${code} makes no table queries`, async () => {
    const client = db([]); mocks.active.mockResolvedValue({ ok: false, code });
    expect(await loadSalonSessions("qa-salon")).toEqual({ ok: false, error: code === "auth_unavailable" ? "server_error" : "unauthorized" });
    expect(client.from).not.toHaveBeenCalled();
  });
  for (const role of ["receptionist", "senior", "nail_tech", null]) it(`denies ${role} without reading presence`, async () => {
    const replies = success(); replies[1] = { data: role ? { role } : null, error: null };
    const client = db(replies);
    expect(await loadSalonSessions("qa-salon")).toEqual({ ok: false, error: "unauthorized" });
    expect(client.from).toHaveBeenCalledTimes(2);
  });
  for (const role of ["owner", "admin", "manager"]) it(`keeps existing ${role} read access scoped to the requested salon`, async () => {
    const replies = success(); replies[1].data = { role }; const client = db(replies);
    const result = await loadSalonSessions("qa-salon");
    expect(result.ok).toBe(true); expect(result.sessions?.[0]).toMatchObject({ memberName: "QA Owner", salonId: "salon" });
    expect(client.chains[0].eq).toHaveBeenCalledWith("slug", "qa-salon");
    expect(client.chains[1].eq).toHaveBeenCalledWith("user_id", "actor");
    for (const chain of client.chains.slice(1)) expect(chain.eq).toHaveBeenCalledWith("salon_id", "salon");
  });
  it("only a successful empty query becomes empty sessions", async () => {
    const replies = success(); replies[2].data = []; const client = db(replies);
    expect(await loadSalonSessions("qa-salon")).toEqual({ ok: true, sessions: [] });
    expect(client.from).toHaveBeenCalledTimes(3);
  });
});
