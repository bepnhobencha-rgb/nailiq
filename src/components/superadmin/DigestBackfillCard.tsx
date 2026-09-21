"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { recoverSalonDigest } from "@/shared/superadmin/digestBackfillActions";

type Result = Awaited<ReturnType<typeof recoverSalonDigest>>;

export function DigestBackfillCard({ salonId, salonName, recoverAction = recoverSalonDigest }: {
  salonId: string; salonName: string; recoverAction?: typeof recoverSalonDigest;
}) {
  const [date, setDate] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [pending, startTransition] = useTransition();
  const ready = result?.ok && result.result.status === "ready" ? result.result : null;
  const complete = result?.ok && ["sent", "already_sent"].includes(result.result.status);

  function run(mode: "check" | "send") {
    startTransition(async () => {
      try {
        setResult(await recoverAction({ salonId, reportDate: date, mode,
          confirmed: mode === "send", expectedRecipientCount: ready?.recipientCount }));
      } catch {
        setResult({ ok: false, error: "verification_required" });
      }
    });
  }

  return (
    <Card as="section" padding="lg" data-testid="digest-backfill" aria-labelledby="digest-backfill-title">
      <h2 id="digest-backfill-title" className="text-lg font-semibold text-nq-foreground">
        Recover daily report · Gửi bù báo cáo
      </h2>
      <p className="mt-2 text-sm text-nq-muted">
        {salonName} — yesterday, or today after 10 PM in the salon’s timezone.
        Chỉ ngày hôm qua hoặc hôm nay sau 22:00 theo giờ tiệm.
      </p>
      <p className="mt-2 text-sm text-nq-muted">
        Regenerated booking summary, not a historical snapshot. Existing recipients only;
        no AI calls, bookings or payments. Báo cáo tổng hợp lại từ dữ liệu hiện có;
        không thay đổi lịch hẹn, thanh toán hoặc người nhận.
      </p>
      <label className="mt-4 grid gap-2 text-sm text-nq-foreground" htmlFor="digest-report-date">
        Report date · Ngày báo cáo
        <Input id="digest-report-date" type="date" value={date} disabled={pending}
          onChange={(e) => { setDate(e.target.value); setResult(null); }} />
      </label>
      <div className="mt-4" aria-live="polite" role="status">
        {ready ? <p className="text-sm text-nq-foreground">
          {date}: {ready.recipientCount} configured recipients. No email sent yet.
          Có {ready.recipientCount} email đã cấu hình; chưa gửi.
        </p> : null}
        {complete ? <p className="text-sm text-nq-foreground">
          Report accepted and receipt saved, or already sent. Do not resend.
          Đã có biên nhận gửi; không gửi lại. Inbox delivery is not yet verified.
        </p> : null}
        {result && !ready && !complete ? <p className="text-sm text-nq-error">
          Recovery stopped — review delivery history before retrying.
          Đã dừng; kiểm tra biên nhận trước khi thử lại.
          {" "}({result.ok && "reason" in result.result ? result.result.reason : !result.ok ? result.error : "verification_required"})
        </p> : null}
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button size="lg" variant={ready ? "secondary" : "primary"} loading={pending}
          disabled={!date || Boolean(complete)} onClick={() => run("check")}>
          Check only · Kiểm tra
        </Button>
        {ready ? <Button size="lg" loading={pending} onClick={() => run("send")}>
          Confirm send · Xác nhận gửi
        </Button> : null}
      </div>
    </Card>
  );
}
