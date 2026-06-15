import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { unsubscribeValid } from "@/shared/lib/emailCompliance";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ e?: string; sig?: string }> };

export default async function UnsubscribePage({ searchParams }: Props) {
  const { e = "", sig = "" } = await searchParams;
  const email = e.trim().toLowerCase();
  const valid = unsubscribeValid(email, sig.trim());

  let done = false;
  if (valid) {
    const { error } = await createServiceRoleClient()
      .from("client_email_optouts" as never)
      .upsert({ email } as never, { onConflict: "email" });
    done = !error;
  }

  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-white px-5 py-16">
      <div className="w-full max-w-md rounded-2xl border border-neutral-200 p-8 text-center">
        {valid && done ? (
          <>
            <p className="text-3xl">✓</p>
            <h1 className="mt-3 text-xl font-semibold text-neutral-900">Unsubscribed</h1>
            <p className="mt-1 text-sm text-neutral-500">Đã ngừng nhận email</p>
            <p className="mt-4 text-sm leading-relaxed text-neutral-600">
              <strong>{email}</strong> will no longer receive reminder, review, or marketing emails.
              You&apos;ll still get essential booking confirmations.
            </p>
            <p className="mt-2 text-sm leading-relaxed text-neutral-500">
              <strong>{email}</strong> sẽ không nhận email nhắc lịch / đánh giá / khuyến mãi nữa.
              Email xác nhận đặt lịch vẫn được gửi.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold text-neutral-900">Link not valid</h1>
            <p className="mt-2 text-sm text-neutral-600">
              This unsubscribe link is invalid or expired. / Liên kết không hợp lệ.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
