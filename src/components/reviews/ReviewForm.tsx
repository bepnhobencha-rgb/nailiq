"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitReviewAction } from "@/shared/reviews/submitReviewAction";

/**
 * Public review form rendered at `/reviews/[token]`. Star picker
 * (1-5) + optional text. On submit calls the server action; success
 * → router.refresh() so the page rerenders the "thank you" state.
 */
type ErrorCode =
  | "not_found"
  | "already_submitted"
  | "invalid_rating"
  | "server_error";

const ERROR_COPY: Record<ErrorCode, string> = {
  not_found: "Link không hợp lệ hoặc đã hết hạn.",
  already_submitted: "Bạn đã đánh giá lần ghé này rồi. Cảm ơn!",
  invalid_rating: "Vui lòng chọn số sao trước khi gửi.",
  server_error: "Có lỗi. Thử lại sau.",
};

export function ReviewForm({ token }: { token: string }) {
  const router = useRouter();
  const [rating, setRating] = useState<number>(0);
  const [hover, setHover] = useState<number>(0);
  const [message, setMessage] = useState<string>("");
  const [error, setError] = useState<ErrorCode | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (rating < 1 || rating > 5) {
      setError("invalid_rating");
      return;
    }
    startTransition(async () => {
      const res = await submitReviewAction(token, rating, message);
      if (res.ok) {
        router.refresh();
        return;
      }
      setError(res.error);
    });
  };

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-5"
      data-testid="review-form"
      noValidate
    >
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-nq-foreground">
          Bạn đánh giá thế nào?
        </label>
        <div
          className="flex items-center gap-2"
          role="radiogroup"
          aria-label="Số sao"
        >
          {[1, 2, 3, 4, 5].map((n) => {
            const filled = hover > 0 ? n <= hover : n <= rating;
            return (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={n === rating}
                aria-label={`${n} sao`}
                onClick={() => setRating(n)}
                onMouseEnter={() => setHover(n)}
                onMouseLeave={() => setHover(0)}
                data-testid={`review-star-${n}`}
                className="text-3xl transition-colors"
                style={{ color: filled ? "#d4af37" : "rgba(255,255,255,0.18)" }}
              >
                ★
              </button>
            );
          })}
        </div>
      </div>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium text-nq-foreground">
          Lời nhắn (không bắt buộc)
        </span>
        <textarea
          value={message}
          onChange={(ev) => setMessage(ev.target.value)}
          maxLength={2000}
          rows={4}
          placeholder="Bạn thấy thế nào về dịch vụ hôm nay?"
          className="w-full rounded-md border border-nq-border/50 bg-nq-bg/40 px-3 py-2 text-sm text-nq-foreground placeholder:text-nq-muted/60 focus:border-nq-primary focus:outline-none"
          data-testid="review-message"
        />
      </label>

      <button
        type="submit"
        disabled={pending}
        data-testid="review-submit"
        className="inline-flex items-center justify-center rounded-full bg-nq-primary px-6 py-3 text-sm font-semibold text-nq-bg hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Đang gửi…" : "Gửi đánh giá"}
      </button>

      {error ? (
        <p className="text-sm text-nq-error" role="alert">
          {ERROR_COPY[error]}
        </p>
      ) : null}
    </form>
  );
}
