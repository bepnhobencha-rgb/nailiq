import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock("react", () => ({ cache: (fn: unknown) => fn }));
vi.mock("@/shared/lib/supabase/publicClient", () => ({ createPublicClient: () => ({}) }));
vi.mock("@/shared/booking/getSalonBySlug", () => ({ fetchSimilarSalonSlugs: async () => [] }));
vi.mock("@/shared/booking/loadBookingServices", () => ({
  loadPublicBookingSnapshot: mocks.snapshot,
  loadBookingServicesForSalonSlug: async (slug: string, _client: unknown, salon: Record<string, unknown>) => ({
    canonicalSlug: slug, salon: { acceptingBookings: salon.profile_complete === true },
  }),
}));
import { resolvePublicBookingPage } from "../resolvePublicBookingPage";
const row = (ready: boolean) => ({ snapshot: { salon: { profile_complete: ready } }, error: null });
describe("public booking freshness after go-live", () => {
  beforeEach(() => { vi.useFakeTimers(); mocks.snapshot.mockReset(); });
  afterEach(() => { vi.runAllTimers(); vi.useRealTimers(); });
  it("rereads a paused salon on the next request without retaining its paused result", async () => {
    mocks.snapshot.mockResolvedValueOnce(row(false)).mockResolvedValueOnce(row(true));
    expect(await resolvePublicBookingPage("freshness-paused")).toMatchObject({ status: "ok", load: { salon: { acceptingBookings: false } } });
    expect(await resolvePublicBookingPage("freshness-paused")).toMatchObject({ status: "ok", load: { salon: { acceptingBookings: true } } });
    expect(mocks.snapshot).toHaveBeenCalledTimes(2);
  });
  it("finds a newly created salon on the next request after a missing lookup", async () => {
    mocks.snapshot.mockResolvedValueOnce({ snapshot: null, error: null }).mockResolvedValueOnce(row(true));
    expect(await resolvePublicBookingPage("freshness-new")).toMatchObject({ status: "not_found" });
    expect(await resolvePublicBookingPage("freshness-new")).toMatchObject({ status: "ok" });
    expect(mocks.snapshot).toHaveBeenCalledTimes(2);
  });
  it("retains the one-second burst sharing for a bookable salon and expires it", async () => {
    mocks.snapshot.mockResolvedValue(row(true));
    await Promise.all([resolvePublicBookingPage("freshness-live"), resolvePublicBookingPage("freshness-live")]);
    await resolvePublicBookingPage("freshness-live");
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1001);
    await resolvePublicBookingPage("freshness-live");
    expect(mocks.snapshot).toHaveBeenCalledTimes(2);
  });
  it.each(["paused", "missing"])("shares an in-flight %s read but rereads after it settles", async (state) => {
    const initial = state === "paused" ? row(false) : { snapshot: null, error: null };
    let finish!: (value: typeof initial) => void;
    mocks.snapshot.mockReturnValueOnce(new Promise<typeof initial>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(row(true));
    const slug = `freshness-flight-${state}`;
    const first = resolvePublicBookingPage(slug);
    const second = resolvePublicBookingPage(slug);
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    finish(initial);
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(results[1]);
    expect(await resolvePublicBookingPage(slug)).toMatchObject({ status: "ok", load: { salon: { acceptingBookings: true } } });
    expect(mocks.snapshot).toHaveBeenCalledTimes(2);
  });

  it("keeps another salon's live snapshot independent of a paused salon reopening", async () => {
    mocks.snapshot.mockImplementation(async (_client: unknown, slug: string) => row(slug === "freshness-salon-b"));
    const [a, b] = await Promise.all([resolvePublicBookingPage("freshness-salon-a"), resolvePublicBookingPage("freshness-salon-b")]);
    expect(a).toMatchObject({ normalizedSlug: "freshness-salon-a", load: { salon: { acceptingBookings: false } } });
    expect(b).toMatchObject({ normalizedSlug: "freshness-salon-b", load: { salon: { acceptingBookings: true } } });
    mocks.snapshot.mockResolvedValue(row(true));
    expect(await resolvePublicBookingPage("freshness-salon-a")).toMatchObject({ load: { salon: { acceptingBookings: true } } });
    expect(await resolvePublicBookingPage("freshness-salon-b")).toEqual(b);
    expect(mocks.snapshot).toHaveBeenCalledTimes(3);
  });

  it("does not turn exhausted read failures into a cached missing salon", async () => {
    mocks.snapshot.mockResolvedValue({ snapshot: null, error: { message: "temporary read failure" } });
    const lookup = resolvePublicBookingPage("freshness-error");
    await vi.advanceTimersByTimeAsync(100);
    expect(await lookup).toMatchObject({ status: "error", reason: "temporary read failure" });
    expect(mocks.snapshot).toHaveBeenCalledTimes(3);
    mocks.snapshot.mockResolvedValue(row(true));
    expect(await resolvePublicBookingPage("freshness-error")).toMatchObject({ status: "ok" });
    expect(mocks.snapshot).toHaveBeenCalledTimes(4);
  });

  it("keeps explicitly supplied clients outside the shared public cache", async () => {
    mocks.snapshot.mockResolvedValueOnce(row(true)).mockResolvedValueOnce(row(false));
    expect(await resolvePublicBookingPage("freshness-client")).toMatchObject({ load: { salon: { acceptingBookings: true } } });
    const client = {} as SupabaseClient;
    expect(await resolvePublicBookingPage("freshness-client", client)).toMatchObject({ load: { salon: { acceptingBookings: false } } });
    expect(await resolvePublicBookingPage("freshness-client")).toMatchObject({ load: { salon: { acceptingBookings: true } } });
    expect(mocks.snapshot).toHaveBeenCalledTimes(2);
    expect(mocks.snapshot.mock.calls[1][0]).toBe(client);
  });

});
