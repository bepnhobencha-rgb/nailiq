"use client";
import { Button } from "@/components/ui/Button";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { actOnCardProtectionException, type CardProtectionException } from "@/shared/booking/cardProtectionExceptionActions";
const button = "min-h-11 rounded-xl border border-nq-border px-3 py-2 text-sm font-medium text-nq-text disabled:opacity-50";
const reasons: Record<string, [string,string]> = {
  configuration: ["Card service connection unavailable", "Chưa kết nối được dịch vụ lưu thẻ"],
  customer_search: ["Customer lookup could not be verified", "Chưa xác minh được hồ sơ khách"],
  customer_create: ["Customer setup could not be verified", "Chưa xác minh được việc tạo hồ sơ khách"],
  card_create: ["Card save was not confirmed", "Chưa xác nhận được thẻ đã lưu"],
  receipt_validation: ["Card receipt needs review", "Cần kiểm tra biên nhận lưu thẻ"],
  dispatch_preparation: ["Card save was not dispatched", "Chưa gửi yêu cầu lưu thẻ"],
  database_completion: ["Checking saved-card confirmation", "Đang kiểm tra xác nhận lưu thẻ"],
  reconciliation: ["Previous attempt needs reconciliation", "Cần đối soát lần lưu trước"],
};
export function CardProtectionExceptions({ slug, result, timezone }: {
  slug: string; result: { ok: boolean; items: CardProtectionException[]; hasMore?: boolean }; timezone: string;
}) {
  const { language } = useUserLanguage(); const vi = language === "vi"; const router = useRouter();
  const [pending, setPending] = useState<string | null>(null); const locked = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [retry, setRetry] = useState<{ bookingId: string; path: string } | null>(null);
  const date = (value: string) => new Intl.DateTimeFormat(vi ? "vi-VN" : "en-CA", { timeZone: timezone,
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  async function act(item: CardProtectionException, action: "retry_link" | "reconcile" | "reviewed") {
    if (locked.current) return; locked.current = true; setPending(item.bookingId); setMessage(null);
    try {
      const outcome = await actOnCardProtectionException(slug, item.bookingId, action);
      if (outcome.retryPath) setRetry({ bookingId: item.bookingId, path: outcome.retryPath });
      setMessage(outcome.ok ? vi ? "Đã cập nhật. Lịch hẹn vẫn được giữ." : "Updated. The appointment remains reserved."
        : vi ? "Chưa thể thực hiện. Vui lòng kiểm tra lại sau." : "Not available yet. Please check again later.");
      router.refresh();
    } catch { setMessage(vi ? "Chưa thể kết nối. Vui lòng thử lại." : "Could not connect. Please try again."); }
    finally { locked.current = false; setPending(null); }
  }
  return <section className="mt-4 rounded-2xl border border-nq-border bg-nq-surface p-4" data-testid="card-protection-exceptions">
    <h2 className="text-lg font-semibold text-nq-text">Card Protection Exceptions</h2>
    <p className="mt-2 text-sm text-nq-muted">{vi ? "Lịch hẹn đã giữ nhưng bảo vệ bằng thẻ chưa kích hoạt." : "Reserved appointments with card protection still inactive."}</p>
    {!result.ok ? <p role="alert" className="mt-3 text-sm text-nq-warning">{vi ? "Chưa tải được danh sách." : "Could not load exceptions."}</p> : null}
    {result.ok && result.items.length === 0 ? <p className="mt-3 text-sm text-nq-muted">{vi ? "Không có ngoại lệ cần xử lý." : "No exceptions to review."}</p> : null}
    <div className="mt-4 space-y-3">{result.items.map((item) => <article key={item.bookingId} className="rounded-xl border border-nq-border p-3">
      <p className="font-semibold text-nq-text">{item.clientLabel} · {item.service}</p>
      <p className="mt-1 text-sm text-nq-muted">{date(item.startTime)}</p>
      <p className="mt-2 text-sm font-medium text-nq-warning">{vi ? "Yêu cầu thẻ — chưa lưu" : "Card required — not saved"}</p>
      <p className="mt-1 text-sm text-nq-muted">{({awaiting_card: ["Awaiting card", "Chờ lưu thẻ"], saving: ["Saving", "Đang lưu"],
        reconciliation_pending: ["Reconciliation pending", "Đang đối soát"], retry_required: ["Retry required", "Cần thử lại"],
        manual_review: ["Manual review", "Cần salon kiểm tra"], saved:["Active","Đã kích hoạt"],not_required:["Not required","Không yêu cầu"]})[item.status][vi ? 1 : 0]}</p>
      <p className="mt-1 text-sm text-nq-muted">{(reasons[item.failureStage ?? ""] ?? ["Waiting for card confirmation", "Đang chờ xác nhận thẻ"])[vi ? 1 : 0]}</p>
      <p className="mt-1 text-sm text-nq-muted">{vi ? "Lần thử gần nhất: " : "Last attempt: "}{item.lastAttemptAt ? date(item.lastAttemptAt) : "—"}</p>
      {item.reviewedAt ? <p className="text-sm text-nq-muted">{vi ? "Đã xem xét: " : "Reviewed: "}{date(item.reviewedAt)}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <a className={button} href={`/dashboard/${encodeURIComponent(slug)}/center?booking=${encodeURIComponent(item.bookingId)}`}>{vi ? "Mở lịch hẹn" : "Open booking"}</a>
        <Button variant="secondary" size="lg" className={button} disabled={pending !== null} onClick={() => void act(item,"retry_link")}>{vi ? "Tạo liên kết thử lại" : "Generate secure retry link"}</Button>
        {["saving","reconciliation_pending","manual_review"].includes(item.status) ? <Button variant="secondary" size="lg" className={button} disabled={pending !== null} onClick={() => void act(item,"reconcile")}>{vi ? "Đối soát lại" : "Reconcile again"}</Button> : null}
        <Button variant="secondary" size="lg" className={button} disabled={pending !== null || !!item.reviewedAt || !item.lastAttemptAt} onClick={() => void act(item,"reviewed")}>{vi ? "Đánh dấu đã xem" : "Mark reviewed"}</Button>
      </div>
      {retry?.bookingId === item.bookingId ? <a href={retry.path} referrerPolicy="no-referrer" className="mt-3 inline-flex min-h-11 items-center text-sm text-nq-text underline">{vi ? "Mở liên kết quản lý thẻ an toàn" : "Open secure card management link"}</a> : null}
    </article>)}</div>
    {result.hasMore ? <p className="mt-3 text-sm text-nq-muted">{vi ? "Đang hiển thị 100 lịch hẹn gần nhất." : "Showing the latest 100 appointments."}</p> : null}
    {message ? <p role="status" className="mt-3 text-sm text-nq-muted">{message}</p> : null}
  </section>;
}
