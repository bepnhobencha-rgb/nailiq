"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { Badge } from "@/components/ui/Badge";
import {
  loadClientIdentityReview,
  mergeClientIdentity,
  revokeClientIdentityMerge,
  type ClientIdentityCandidate,
  type ClientIdentityProfile,
  type LoadClientIdentityReviewResult,
} from "@/shared/dashboard/clientIdentityReviewAction";
import { formatPhone } from "@/shared/lib/phoneFormat";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

const COPY = {
  en: {
    title: "Customer identity review",
    subtitle:
      "NailIQ found profiles that may represent the same customer. Review both records before choosing the identity to keep.",
    noCandidates: "No unreviewed duplicate candidates.",
    high: "Strong match",
    review: "Review",
    same_email: "same email",
    same_phone_tail: "same phone",
    same_name: "same name",
    visits: (count: number) => `${count} visits`,
    spent: (cents: number) => `$${(cents / 100).toFixed(2)} spent`,
    keep: "Keep this identity",
    keeping: "Keep",
    merging: "Merge",
    reasonLabel: "Review evidence",
    reasonPlaceholder:
      "Who reviewed the profiles and which details prove they are one customer?",
    confirm:
      "I reviewed both records and understand this changes customer attribution for this salon.",
    apply: "Merge profiles",
    cancel: "Cancel",
    ownerOnly: "Only an Owner can merge or undo customer identities.",
    activeTitle: "Active merges",
    alias: "Alias",
    canonical: "Canonical",
    undoReason: "Why should this merge be undone?",
    undo: "Undo merge",
    historyTitle: "Recent identity history",
    merge: "Merged",
    revoke: "Undone",
    affected: (count: number) => `${count} bookings updated`,
    saved: (count: number) => `Identity updated · ${count} bookings`,
    error: "The identity change could not be completed. Refresh and review again.",
    unavailable: "Customer identity review is temporarily unavailable.",
  },
  vi: {
    title: "Rà soát danh tính khách",
    subtitle:
      "NailIQ phát hiện các hồ sơ có thể là cùng một khách. Hãy xem cả hai hồ sơ trước khi chọn danh tính cần giữ.",
    noCandidates: "Không có hồ sơ trùng chưa xử lý.",
    high: "Khớp mạnh",
    review: "Cần xem",
    same_email: "cùng email",
    same_phone_tail: "cùng số điện thoại",
    same_name: "cùng tên",
    visits: (count: number) => `${count} lượt`,
    spent: (cents: number) => `đã chi $${(cents / 100).toFixed(2)}`,
    keep: "Giữ danh tính này",
    keeping: "Giữ",
    merging: "Gộp",
    reasonLabel: "Bằng chứng rà soát",
    reasonPlaceholder:
      "Ai đã kiểm tra và chi tiết nào chứng minh đây là cùng một khách?",
    confirm:
      "Tôi đã xem cả hai hồ sơ và hiểu thao tác này thay đổi danh tính khách trong tiệm này.",
    apply: "Gộp hồ sơ",
    cancel: "Hủy",
    ownerOnly: "Chỉ Owner mới có thể gộp hoặc hoàn tác danh tính khách.",
    activeTitle: "Các hồ sơ đang gộp",
    alias: "Hồ sơ phụ",
    canonical: "Hồ sơ chính",
    undoReason: "Vì sao cần hoàn tác lần gộp này?",
    undo: "Hoàn tác gộp",
    historyTitle: "Lịch sử danh tính gần đây",
    merge: "Đã gộp",
    revoke: "Đã hoàn tác",
    affected: (count: number) => `${count} lịch hẹn được cập nhật`,
    saved: (count: number) => `Đã cập nhật danh tính · ${count} lịch hẹn`,
    error: "Không thể hoàn tất thay đổi. Hãy tải lại và kiểm tra lại.",
    unavailable: "Tạm thời chưa tải được phần rà soát danh tính khách.",
  },
} as const;

function ProfileSummary({
  profile,
  label,
}: {
  profile: ClientIdentityProfile;
  label?: string;
}) {
  const { language } = useUserLanguage();
  const tx = COPY[language === "vi" ? "vi" : "en"];
  return (
    <div
      className="min-w-0 rounded-xl border border-nq-border/60 bg-nq-bg p-3"
      data-testid={`identity-profile-${profile.id}`}
    >
      {label ? (
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
          {label}
        </p>
      ) : null}
      <p className="truncate font-semibold text-nq-foreground">
        {profile.name || "—"}
      </p>
      <p className="mt-1 font-mono text-xs text-nq-muted">
        {profile.phone ? formatPhone(profile.phone) : "—"}
      </p>
      {profile.email ? (
        <p className="mt-1 truncate text-xs text-nq-muted">{profile.email}</p>
      ) : null}
      <p className="mt-2 text-xs text-nq-muted">
        {tx.visits(profile.visitCount)} · {tx.spent(profile.totalSpentCents)}
      </p>
    </div>
  );
}

export function ClientIdentityReviewPanel({
  slug,
  initial,
}: {
  slug: string;
  initial: LoadClientIdentityReviewResult;
}) {
  const { language } = useUserLanguage();
  const tx = COPY[language === "vi" ? "vi" : "en"];
  const [state, setState] = useState(initial);
  const [decision, setDecision] = useState<{
    candidateKey: string;
    canonicalProfileId: string;
    aliasProfileId: string;
  } | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [undoId, setUndoId] = useState<string | null>(null);
  const [undoReason, setUndoReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const refresh = useCallback(async () => {
    const next = await loadClientIdentityReview(slug);
    setState(next);
  }, [slug]);

  const ready = state.ok ? state : null;
  const activeIds = useMemo(
    () =>
      new Set(
        ready?.activeMerges.flatMap((merge) => [
          merge.canonical.id,
          merge.alias.id,
        ]) ?? [],
      ),
    [ready],
  );
  const candidates =
    ready?.candidates.filter(
      (candidate) =>
        !activeIds.has(candidate.left.id) &&
        !activeIds.has(candidate.right.id),
    ) ?? [];

  if (!state.ok) {
    return (
      <section className="mb-6 rounded-2xl border border-nq-border bg-nq-surface p-4 md:p-5">
        <h2 className="text-base font-semibold text-nq-foreground">
          {tx.title}
        </h2>
        <p role="alert" className="mt-2 text-sm text-nq-error">
          {tx.unavailable}
        </p>
      </section>
    );
  }

  const chooseCanonical = (
    candidate: ClientIdentityCandidate,
    canonical: ClientIdentityProfile,
    alias: ClientIdentityProfile,
  ) => {
    setDecision({
      candidateKey: candidate.key,
      canonicalProfileId: canonical.id,
      aliasProfileId: alias.id,
    });
    setReason("");
    setConfirmed(false);
    setMessage(null);
  };

  const submitMerge = () => {
    if (!decision || !confirmed || reason.trim().length < 10) return;
    startTransition(async () => {
      const result = await mergeClientIdentity(slug, {
        canonicalProfileId: decision.canonicalProfileId,
        aliasProfileId: decision.aliasProfileId,
        reason,
      });
      if (!result.ok) {
        setMessage(tx.error);
        return;
      }
      setMessage(tx.saved(result.affectedBookings));
      setDecision(null);
      setReason("");
      setConfirmed(false);
      await refresh();
    });
  };

  const submitUndo = () => {
    if (!undoId || undoReason.trim().length < 10) return;
    startTransition(async () => {
      const result = await revokeClientIdentityMerge(slug, {
        aliasId: undoId,
        reason: undoReason,
      });
      if (!result.ok) {
        setMessage(tx.error);
        return;
      }
      setMessage(tx.saved(result.affectedBookings));
      setUndoId(null);
      setUndoReason("");
      await refresh();
    });
  };

  return (
    <section
      className="mb-6 rounded-2xl border border-nq-border bg-nq-surface p-4 md:p-5"
      data-testid="client-identity-review"
    >
      <h2 className="text-base font-semibold text-nq-foreground">
        🧬 {tx.title}
      </h2>
      <p className="mt-1 max-w-3xl text-xs text-nq-muted">{tx.subtitle}</p>
      {!state.canMerge ? (
        <p className="mt-3 rounded-lg bg-nq-muted/10 px-3 py-2 text-xs text-nq-muted">
          {tx.ownerOnly}
        </p>
      ) : null}

      {message ? (
        <p
          role="status"
          className="mt-3 rounded-lg bg-nq-primary/10 px-3 py-2 text-sm text-nq-primary"
        >
          {message}
        </p>
      ) : null}

      <div className="mt-4 space-y-4">
        {candidates.length === 0 ? (
          <p className="rounded-xl border border-dashed border-nq-border px-3 py-4 text-sm text-nq-muted">
            {tx.noCandidates}
          </p>
        ) : (
          candidates.map((candidate) => {
            const isSelected = decision?.candidateKey === candidate.key;
            return (
              <article
                key={candidate.key}
                className="rounded-xl border border-nq-border/70 p-3"
                data-testid={`identity-candidate-${candidate.key}`}
              >
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <Badge
                    variant={
                      candidate.confidence === "high" ? "info" : "warning"
                    }
                  >
                    {candidate.confidence === "high" ? tx.high : tx.review}
                  </Badge>
                  <span className="text-xs text-nq-muted">
                    {candidate.reasons
                      .map((reasonKey) => tx[reasonKey])
                      .join(" · ")}
                  </span>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {[candidate.left, candidate.right].map((profile) => (
                    <div key={profile.id} className="space-y-2">
                      <ProfileSummary profile={profile} />
                      {state.canMerge ? (
                        <button
                          type="button"
                          className="min-h-11 w-full rounded-lg border border-nq-primary/40 px-3 py-2 text-sm font-medium text-nq-primary hover:bg-nq-primary/10 disabled:opacity-50"
                          disabled={isPending}
                          onClick={() =>
                            chooseCanonical(
                              candidate,
                              profile,
                              profile.id === candidate.left.id
                                ? candidate.right
                                : candidate.left,
                            )
                          }
                        >
                          {tx.keep}
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>

                {isSelected ? (
                  <div className="mt-4 rounded-xl bg-nq-bg p-3">
                    <div className="grid gap-2 text-xs md:grid-cols-2">
                      <p>
                        <span className="font-semibold text-nq-foreground">
                          {tx.keeping}:
                        </span>{" "}
                        {
                          [candidate.left, candidate.right].find(
                            (profile) =>
                              profile.id === decision.canonicalProfileId,
                          )?.name
                        }
                      </p>
                      <p>
                        <span className="font-semibold text-nq-foreground">
                          {tx.merging}:
                        </span>{" "}
                        {
                          [candidate.left, candidate.right].find(
                            (profile) =>
                              profile.id === decision.aliasProfileId,
                          )?.name
                        }
                      </p>
                    </div>
                    <label className="mt-3 block text-xs font-semibold text-nq-foreground">
                      {tx.reasonLabel}
                      <textarea
                        value={reason}
                        maxLength={500}
                        rows={3}
                        onChange={(event) => setReason(event.target.value)}
                        placeholder={tx.reasonPlaceholder}
                        className="mt-1 w-full resize-y rounded-lg border border-nq-border bg-nq-surface px-3 py-2 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-nq-primary"
                      />
                    </label>
                    <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-nq-muted">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        onChange={(event) => setConfirmed(event.target.checked)}
                        className="mt-0.5 size-4"
                      />
                      <span>{tx.confirm}</span>
                    </label>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={
                          isPending ||
                          !confirmed ||
                          reason.trim().length < 10
                        }
                        onClick={submitMerge}
                        className="min-h-11 rounded-lg bg-nq-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                      >
                        {tx.apply}
                      </button>
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => setDecision(null)}
                        className="min-h-11 rounded-lg border border-nq-border px-4 py-2 text-sm text-nq-foreground"
                      >
                        {tx.cancel}
                      </button>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })
        )}
      </div>

      {state.activeMerges.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-nq-foreground">
            {tx.activeTitle}
          </h3>
          <div className="mt-2 space-y-3">
            {state.activeMerges.map((merge) => (
              <article
                key={merge.id}
                className="rounded-xl border border-nq-border/70 p-3"
              >
                <div className="grid gap-3 md:grid-cols-2">
                  <ProfileSummary
                    profile={merge.canonical}
                    label={tx.canonical}
                  />
                  <ProfileSummary profile={merge.alias} label={tx.alias} />
                </div>
                {state.canMerge ? (
                  undoId === merge.id ? (
                    <div className="mt-3">
                      <label className="block text-xs font-semibold text-nq-foreground">
                        {tx.undoReason}
                        <textarea
                          value={undoReason}
                          maxLength={500}
                          rows={2}
                          onChange={(event) =>
                            setUndoReason(event.target.value)
                          }
                          className="mt-1 w-full resize-y rounded-lg border border-nq-border bg-nq-bg px-3 py-2 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-nq-primary"
                        />
                      </label>
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          disabled={
                            isPending || undoReason.trim().length < 10
                          }
                          onClick={submitUndo}
                          className="min-h-11 rounded-lg border border-nq-error/50 px-3 py-2 text-sm font-medium text-nq-error disabled:opacity-50"
                        >
                          {tx.undo}
                        </button>
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() => setUndoId(null)}
                          className="min-h-11 rounded-lg border border-nq-border px-3 py-2 text-sm"
                        >
                          {tx.cancel}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => {
                        setUndoId(merge.id);
                        setUndoReason("");
                        setMessage(null);
                      }}
                      className="mt-3 min-h-11 rounded-lg border border-nq-border px-3 py-2 text-sm text-nq-muted"
                    >
                      {tx.undo}
                    </button>
                  )
                ) : null}
              </article>
            ))}
          </div>
        </div>
      ) : null}

      {state.history.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-nq-foreground">
            {tx.historyTitle}
          </h3>
          <ol className="mt-2 divide-y divide-nq-border/60 rounded-xl border border-nq-border/70">
            {state.history.map((event) => (
              <li key={event.id} className="px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-nq-foreground">
                    {event.action === "merge" ? tx.merge : tx.revoke}:{" "}
                    {event.aliasName || formatPhone(event.aliasPhone)} →{" "}
                    {event.canonicalName || "—"}
                  </span>
                  <time className="text-nq-muted">
                    {new Date(event.createdAt).toLocaleString(
                      language === "vi" ? "vi-VN" : "en-CA",
                    )}
                  </time>
                </div>
                <p className="mt-1 text-nq-muted">{event.reason}</p>
                <p className="mt-1 text-nq-muted">
                  {tx.affected(event.affectedBookings)}
                </p>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
