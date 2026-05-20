import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import Link from "next/link";

type Props = { searchParams: Promise<{ token?: string }> };

export default async function WaitlistClaimPage({ searchParams }: Props) {
  const { token } = await searchParams;

  if (!token) {
    return <Shell><Result ok={false} message="This claim link is invalid." /></Shell>;
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc("claim_waitlist_slot" as never, {
    p_claim_token: token,
  });

  if (error) {
    console.error("[waitlist-claim] RPC error", error);
    return <Shell><Result ok={false} message="Something went wrong. Please contact the salon." /></Shell>;
  }

  const rows = Array.isArray(data) ? data : [];
  const row = rows[0] as { id: string; client_name: string } | undefined;

  if (!row) {
    return (
      <Shell>
        <Result
          ok={false}
          message="This slot has already been claimed by another customer. We're sorry — first to claim wins!"
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full border border-nq-gold/30 bg-nq-gold/10">
          <svg className="h-8 w-8 text-nq-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-2xl font-semibold text-white">Spot Claimed!</h1>
        <p className="mt-3 text-sm text-nq-muted">
          Great news, {row.client_name}! Your spot has been reserved. The salon will follow up to confirm your appointment details.
        </p>
        <p className="mt-6 text-sm text-nq-muted">You can close this page.</p>
      </div>
    </Shell>
  );
}

function Result({ ok, message }: { ok: boolean; message: string }) {
  void ok;
  return (
    <div className="text-center">
      <h1 className="text-xl font-semibold text-white">
        {ok ? "Done!" : "Slot Unavailable"}
      </h1>
      <p className="mt-3 text-sm text-nq-muted">{message}</p>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-nq-bg px-4">
      <div className="w-full max-w-sm rounded-2xl border border-nq-border/40 bg-nq-surface p-8">
        {children}
        <p className="mt-8 text-center text-xs text-nq-muted/50">
          Powered by{" "}
          <Link href="https://nailiq.ca" className="underline">
            NailIQ
          </Link>
        </p>
      </div>
    </div>
  );
}
