"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveGuidedBookingPolicy } from "@/shared/noshow/guidedBookingPolicyAction";

type Props = {
  slug: string;
  cancellationPolicyEn: string;
  cancellationPolicyVi: string;
  policySaved: boolean;
  groupBookingEnabled: boolean;
  groupPolicySaved: boolean;
  groupTogetherThresholdMinutes: number;
  noShowGroupWholeParty: boolean;
};

export function GuidedBookingPolicySetup({
  slug,
  cancellationPolicyEn,
  cancellationPolicyVi,
  policySaved: initialPolicySaved,
  groupBookingEnabled,
  groupPolicySaved: initialGroupPolicySaved,
  groupTogetherThresholdMinutes: initialGroupWindow,
  noShowGroupWholeParty: initialWholeParty,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [policyEn, setPolicyEn] = useState(cancellationPolicyEn);
  const [policyVi, setPolicyVi] = useState(cancellationPolicyVi);
  const [groupWindow, setGroupWindow] = useState(String(initialGroupWindow));
  const [wholeParty, setWholeParty] = useState(initialWholeParty);
  const [policySaved, setPolicySaved] = useState(initialPolicySaved);
  const [groupPolicySaved, setGroupPolicySaved] = useState(
    initialGroupPolicySaved,
  );
  const [message, setMessage] = useState<string | null>(null);

  function savePolicy() {
    startTransition(async () => {
      const result = await saveGuidedBookingPolicy(slug, {
        en: policyEn,
        vi: policyVi,
        ...(groupBookingEnabled
          ? {
              groupTogetherThresholdMinutes: Number(groupWindow),
              noShowGroupWholeParty: wholeParty,
            }
          : {}),
      });
      if (!result.ok) {
        setMessage(
          result.error === "policy_languages_required"
            ? "Cần nhập cả English và Tiếng Việt / Both languages are required."
            : result.error === "policy_placeholders_remaining"
              ? "Cần thay mọi mục [24 giờ] / [X%] trước khi lưu. / Replace every bracketed placeholder."
            : "Không lưu được / Could not save.",
        );
        return;
      }
      setPolicySaved(true);
      if (groupBookingEnabled) setGroupPolicySaved(true);
      setMessage("Đã lưu chính sách / Policy saved.");
      router.refresh();
    });
  }

  return (
    <section
      data-testid="guided-booking-policy-only"
      className="rounded-2xl border border-nq-border bg-nq-surface p-5 sm:p-6"
    >
      <h1 className="text-xl font-bold text-nq-foreground">
        Quy định đặt và huỷ lịch / Booking and cancellation rules
      </h1>
      <p className="mt-2 text-sm leading-6 text-nq-muted">
        Chính sách rõ ràng về huỷ lịch, vắng mặt, đặt nhóm và ngoài giờ giúp
        giảm khiếu nại và giúp nhân viên áp dụng nhất quán. / Clear
        cancellation, no-show, group, and after-hours rules reduce disputes and
        guesswork.
      </p>

      <div className="mt-5 rounded-xl border border-nq-primary/30 bg-nq-primary/5 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-nq-primary">
          Dữ liệu còn thiếu / Missing data
        </p>
        <ul className="mt-3 space-y-2 text-sm text-nq-muted">
          <li data-testid="guided-policy-language-status">
            {policySaved ? "✓" : "○"} Chính sách riêng bằng English và Tiếng
            Việt
          </li>
          <li data-testid="guided-policy-group-status">
            {!groupBookingEnabled
              ? "— Đặt nhóm chưa bật (không bắt buộc) / Group booking is optional"
              : `${groupPolicySaved ? "✓" : "○"} Khung giờ đi cùng nhau và quy định vắng mặt của nhóm`}
          </li>
          <li data-testid="guided-policy-after-hours-status">
            Khóa an toàn (không cần thiết lập): mọi lịch ngoài giờ đều cần
            Owner/Admin duyệt từng lịch và nhân viên đồng ý / Safety rule (no
            setup required): every after-hours booking requires per-booking
            Owner/Admin approval and staff consent
          </li>
        </ul>
      </div>

      <div className="mt-5">
        <label
          className="block text-sm font-medium text-nq-foreground"
          htmlFor="guided-policy-en"
        >
          English
        </label>
        <textarea
          id="guided-policy-en"
          data-testid="guided-policy-en"
          rows={6}
          value={policyEn}
          onChange={(event) => setPolicyEn(event.target.value)}
          className="mt-2 w-full rounded-xl border border-nq-border bg-nq-bg px-3 py-2 text-sm text-nq-foreground focus:border-nq-primary focus:outline-none"
        />
      </div>

      <div className="mt-4">
        <label
          className="block text-sm font-medium text-nq-foreground"
          htmlFor="guided-policy-vi"
        >
          Tiếng Việt
        </label>
        <textarea
          id="guided-policy-vi"
          data-testid="guided-policy-vi"
          rows={6}
          value={policyVi}
          onChange={(event) => setPolicyVi(event.target.value)}
          className="mt-2 w-full rounded-xl border border-nq-border bg-nq-bg px-3 py-2 text-sm text-nq-foreground focus:border-nq-primary focus:outline-none"
        />
      </div>

      {groupBookingEnabled ? (
        <div
          className="mt-5 rounded-xl border border-nq-border p-4"
          data-testid="guided-group-policy"
        >
          <label className="flex items-center justify-between gap-4 text-sm text-nq-foreground">
            <span>
              Khung giờ nhóm đi cùng nhau / Together window (0–120 minutes)
            </span>
            <input
              type="number"
              min="0"
              max="120"
              value={groupWindow}
              onChange={(event) => setGroupWindow(event.target.value)}
              className="w-20 rounded-lg border border-nq-border bg-nq-bg px-2 py-1.5"
              data-testid="guided-group-window"
            />
          </label>
          <label className="mt-4 flex items-start gap-3 text-sm text-nq-foreground">
            <input
              type="checkbox"
              checked={wholeParty}
              onChange={(event) => setWholeParty(event.target.checked)}
              className="mt-0.5 h-4 w-4 accent-nq-primary"
              data-testid="guided-group-whole-party"
            />
            <span>
              Áp dụng quy định vắng mặt cho cả nhóm / Apply the no-show rule to
              the whole party
            </span>
          </label>
        </div>
      ) : null}

      <button
        type="button"
        onClick={savePolicy}
        disabled={isPending}
        data-testid="guided-policy-save"
        className="mt-5 min-h-11 rounded-full bg-nq-primary px-5 text-base font-semibold text-nq-bg disabled:opacity-50"
      >
        {isPending ? "Đang lưu… / Saving…" : "Lưu chính sách / Save policy"}
      </button>
      {message ? (
        <p className="mt-3 text-sm text-nq-muted" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
