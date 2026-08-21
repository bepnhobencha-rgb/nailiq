import { describe, expect, it } from "vitest";

/**
 * Executable reference contract for MQA-0099.
 *
 * This model deliberately lives in the test: it proves that the lifecycle
 * requirements are internally consistent, but it is NOT runtime evidence.
 * Replace the model calls with the real DB/RPC boundary once that additive
 * contract lands; the assertions should remain unchanged.
 */

type Action = "status" | "confirm" | "reschedule" | "cancel";
type BookingStatus = "pending" | "confirmed" | "cancelled";

type Capability = {
  id: string;
  bookingId: string;
  action: Action;
  epoch: number;
  expiresAtMs: number;
  usedAtMs: number | null;
  revokedAtMs: number | null;
  requestId: string | null;
  fingerprint: string | null;
  result: { ok: true; status: BookingStatus; action: Action } | null;
};

class ReferenceManagementTokens {
  private sequence = 0;
  private readonly locks = new Map<string, Promise<void>>();
  readonly capabilities: Capability[] = [];
  readonly booking = {
    id: "booking-1",
    status: "pending" as BookingStatus,
    epochs: { status: 1, confirm: 1, reschedule: 1, cancel: 1 } satisfies Record<Action, number>,
  };

  private async locked<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }

  async mint(action: Action, requestedExpiryMs: number): Promise<Capability> {
    return this.locked(`${this.booking.id}:${action}`, () => {
      if (this.booking.status === "cancelled" && action !== "status") {
        throw new Error("booking_terminal");
      }
      const epoch = this.booking.epochs[action];
      const reusable = this.capabilities.find(
        (token) =>
          token.bookingId === this.booking.id &&
          token.action === action &&
          token.epoch === epoch &&
          token.usedAtMs === null &&
          token.revokedAtMs === null &&
          token.expiresAtMs >= requestedExpiryMs,
      );
      if (reusable) return reusable;

      for (const token of this.capabilities) {
        if (
          token.bookingId === this.booking.id &&
          token.action === action &&
          token.epoch === epoch &&
          token.usedAtMs === null &&
          token.revokedAtMs === null
        ) {
          token.revokedAtMs = Date.now();
        }
      }

      const token: Capability = {
        id: `token-${++this.sequence}`,
        bookingId: this.booking.id,
        action,
        epoch,
        expiresAtMs: requestedExpiryMs,
        usedAtMs: null,
        revokedAtMs: null,
        requestId: null,
        fingerprint: null,
        result: null,
      };
      this.capabilities.push(token);
      return token;
    });
  }

  inspect(tokenId: string, action: Action, nowMs: number) {
    const token = this.capabilities.find((candidate) => candidate.id === tokenId);
    if (!token || token.action !== action) return { ok: false, code: "invalid_token" } as const;
    if (token.revokedAtMs !== null || token.expiresAtMs <= nowMs) {
      return { ok: false, code: "expired_or_revoked" } as const;
    }
    if (this.booking.status === "cancelled" && action !== "status") {
      return { ok: false, code: "booking_terminal" } as const;
    }
    return { ok: true, bookingId: token.bookingId, status: this.booking.status } as const;
  }

  async consume(
    tokenId: string,
    action: Exclude<Action, "status">,
    requestId: string,
    fingerprint: string,
    nowMs: number,
  ) {
    return this.locked(`consume:${tokenId}`, () => {
      const token = this.capabilities.find((candidate) => candidate.id === tokenId);
      if (!token || token.action !== action) return { ok: false, code: "invalid_token" } as const;
      if (token.result) {
        if (token.requestId === requestId && token.fingerprint === fingerprint) return token.result;
        return { ok: false, code: "token_used" } as const;
      }
      if (
        token.revokedAtMs !== null ||
        token.expiresAtMs <= nowMs ||
        token.epoch !== this.booking.epochs[action]
      ) {
        return { ok: false, code: "expired_or_revoked" } as const;
      }
      if (this.booking.status === "cancelled") {
        return { ok: false, code: "booking_terminal" } as const;
      }

      if (action === "confirm") this.booking.status = "confirmed";
      if (action === "cancel") this.booking.status = "cancelled";
      this.booking.epochs[action] += 1;
      token.usedAtMs = nowMs;
      token.requestId = requestId;
      token.fingerprint = fingerprint;
      token.result = { ok: true, status: this.booking.status, action };

      if (action === "cancel") {
        for (const candidate of this.capabilities) {
          if (
            candidate.id !== token.id &&
            candidate.action !== "status" &&
            candidate.revokedAtMs === null
          ) {
            candidate.revokedAtMs = nowMs;
          }
        }
      }
      return token.result;
    });
  }
}

type GroupScope =
  | { kind: "member_own"; bookingId: string; groupId: string; partyVersion: number }
  | { kind: "organizer_own"; bookingId: string; groupId: string; partyVersion: number }
  | {
      kind: "organizer_whole_party";
      bookingId: string;
      groupId: string;
      partyVersion: number;
      memberBookingIds: string[];
    };

function resolveGroupCancellationTargets(
  scope: GroupScope,
  request: { mode: "my_spot" | "entire_party"; groupId: string; partyVersion: number },
): string[] | null {
  if (scope.groupId !== request.groupId || scope.partyVersion !== request.partyVersion) return null;
  if (request.mode === "my_spot") return [scope.bookingId];
  return scope.kind === "organizer_whole_party" ? [...scope.memberBookingIds] : null;
}

describe("MQA-0099 action-scoped capability reference contract", () => {
  const now = Date.parse("2099-01-01T00:00:00.000Z");

  it("keeps Confirm, Reschedule, and Cancel independent", async () => {
    const store = new ReferenceManagementTokens();
    const [confirm, reschedule, cancel] = await Promise.all([
      store.mint("confirm", now + 60_000),
      store.mint("reschedule", now + 60_000),
      store.mint("cancel", now + 60_000),
    ]);

    expect(await store.consume(confirm.id, "confirm", "request-confirm", "confirm-v1", now)).toEqual({
      ok: true,
      status: "confirmed",
      action: "confirm",
    });
    expect(store.inspect(reschedule.id, "reschedule", now)).toMatchObject({ ok: true });
    expect(store.inspect(cancel.id, "cancel", now)).toMatchObject({ ok: true });
  });

  it("makes inspection side-effect-free", async () => {
    const store = new ReferenceManagementTokens();
    const token = await store.mint("confirm", now + 60_000);
    const before = structuredClone(store.capabilities);
    expect(store.inspect(token.id, "confirm", now)).toMatchObject({ ok: true });
    expect(store.inspect(token.id, "confirm", now)).toMatchObject({ ok: true });
    expect(store.capabilities).toEqual(before);
    expect(store.booking.status).toBe("pending");
  });

  it("never shortens requested expiry when reusing a token", async () => {
    const store = new ReferenceManagementTokens();
    const short = await store.mint("reschedule", now + 48 * 60 * 60 * 1_000);
    const long = await store.mint("reschedule", now + 30 * 24 * 60 * 60 * 1_000);
    expect(long.expiresAtMs).toBeGreaterThan(short.expiresAtMs);
    expect(short.revokedAtMs).not.toBeNull();

    const reused = await store.mint("reschedule", now + 7 * 24 * 60 * 60 * 1_000);
    expect(reused.id).toBe(long.id);
    expect(reused.expiresAtMs).toBe(long.expiresAtMs);
  });

  it("serializes concurrent minting to one deterministic active token", async () => {
    const store = new ReferenceManagementTokens();
    const minted = await Promise.all(
      Array.from({ length: 20 }, () => store.mint("cancel", now + 60_000)),
    );
    expect(new Set(minted.map((token) => token.id))).toEqual(new Set(["token-1"]));
    expect(store.capabilities.filter((token) => token.revokedAtMs === null)).toHaveLength(1);
  });

  it("replays the exact acknowledged mutation but rejects changed payload", async () => {
    const store = new ReferenceManagementTokens();
    const token = await store.mint("reschedule", now + 60_000);
    const first = await store.consume(token.id, "reschedule", "request-1", "slot-A-to-B", now);
    expect(await store.consume(token.id, "reschedule", "request-1", "slot-A-to-B", now + 1)).toEqual(first);
    expect(await store.consume(token.id, "reschedule", "request-1", "slot-A-to-C", now + 2)).toEqual({
      ok: false,
      code: "token_used",
    });
  });

  it("does not treat a naked booking id as a status capability", async () => {
    const store = new ReferenceManagementTokens();
    const status = await store.mint("status", now + 60_000);
    expect(store.inspect(store.booking.id, "status", now)).toEqual({ ok: false, code: "invalid_token" });
    expect(store.inspect(status.id, "status", now)).toMatchObject({
      ok: true,
      bookingId: store.booking.id,
    });
  });

  it("fails closed on action mismatch", async () => {
    const store = new ReferenceManagementTokens();
    const confirm = await store.mint("confirm", now + 60_000);
    expect(await store.consume(confirm.id, "cancel", "request-1", "cancel-v1", now)).toEqual({
      ok: false,
      code: "invalid_token",
    });
  });

  it("treats terminal cancellation as the explicit cross-action revocation exception", async () => {
    const store = new ReferenceManagementTokens();
    const status = await store.mint("status", now + 60_000);
    const reschedule = await store.mint("reschedule", now + 60_000);
    const cancel = await store.mint("cancel", now + 60_000);
    await store.consume(cancel.id, "cancel", "request-cancel", "cancel-v1", now);
    expect(store.inspect(reschedule.id, "reschedule", now + 1)).toEqual({
      ok: false,
      code: "expired_or_revoked",
    });
    expect(store.inspect(status.id, "status", now + 1)).toMatchObject({
      ok: true,
      status: "cancelled",
    });
  });

  it("keeps member and organizer-own capabilities scoped to one booking", () => {
    const member: GroupScope = {
      kind: "member_own",
      bookingId: "member-2",
      groupId: "group-1",
      partyVersion: 7,
    };
    const organizer: GroupScope = {
      kind: "organizer_own",
      bookingId: "organizer-1",
      groupId: "group-1",
      partyVersion: 7,
    };
    const entireParty = { mode: "entire_party", groupId: "group-1", partyVersion: 7 } as const;

    expect(resolveGroupCancellationTargets(member, entireParty)).toBeNull();
    expect(resolveGroupCancellationTargets(organizer, entireParty)).toBeNull();
    expect(
      resolveGroupCancellationTargets(member, {
        mode: "my_spot",
        groupId: "group-1",
        partyVersion: 7,
      }),
    ).toEqual(["member-2"]);
  });

  it("allows only an explicit organizer whole-party capability with the exact party version", () => {
    const capability: GroupScope = {
      kind: "organizer_whole_party",
      bookingId: "organizer-1",
      groupId: "group-1",
      partyVersion: 7,
      memberBookingIds: ["organizer-1", "member-2", "member-3"],
    };

    expect(
      resolveGroupCancellationTargets(capability, {
        mode: "entire_party",
        groupId: "group-1",
        partyVersion: 7,
      }),
    ).toEqual(["organizer-1", "member-2", "member-3"]);
    expect(
      resolveGroupCancellationTargets(capability, {
        mode: "entire_party",
        groupId: "group-1",
        partyVersion: 8,
      }),
    ).toBeNull();
  });
});
