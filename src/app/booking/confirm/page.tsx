import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

type Props = { searchParams: Promise<{ token?: string }> };

export default async function ConfirmBookingPage({ searchParams }: Props) {
  const { token } = await searchParams;

  if (!token) {
    return <ActionResult ok={false} code="missing_token" />;
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc("confirm_booking_as_customer" as never, {
    p_token_id: token,
  });

  if (error) {
    console.error("[confirm] RPC error", error);
    return <ActionResult ok={false} code="server_error" />;
  }

  const rows = Array.isArray(data) ? data : [];
  const row = rows[0] as {
    ok: boolean;
    code: string;
    service_name?: string;
    staff_name?: string;
    start_utc?: string;
  } | undefined;

  if (!row?.ok) {
    return <ActionResult ok={false} code={row?.code ?? "unknown"} />;
  }

  const formattedTime = row.start_utc
    ? new Date(row.start_utc).toLocaleString("en-US", {
        timeZone: "America/Los_Angeles",
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
    : "";

  return (
    <ActionShell>
      <div className="text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full border border-nq-gold/30 bg-nq-gold/10">
          <svg className="h-8 w-8 text-nq-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-2xl font-semibold text-white">Appointment Confirmed</h1>
        {row.service_name && (
          <p className="mt-3 text-nq-muted">
            <span className="font-medium text-nq-text">{row.service_name}</span>
            {row.staff_name && <> · {row.staff_name}</>}
          </p>
        )}
        {formattedTime && (
          <p className="mt-1 text-sm text-nq-muted">{formattedTime}</p>
        )}
        <p className="mt-6 text-sm text-nq-muted">
          We look forward to seeing you! You can close this page.
        </p>
      </div>
    </ActionShell>
  );
}

function ActionResult({ ok, code }: { ok: boolean; code: string }) {
  const messages: Record<string, string> = {
    missing_token: "This confirmation link is invalid.",
    token_invalid: "This link has already been used or has expired.",
    booking_not_found: "This appointment was not found or is no longer active.",
    server_error: "Something went wrong. Please contact the salon directly.",
  };
  const msg = messages[code] ?? "Unable to process your request.";

  return (
    <ActionShell>
      <div className="text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full border border-red-500/30 bg-red-500/10">
          <svg className="h-8 w-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
        <h1 className="text-2xl font-semibold text-white">
          {ok ? "Done" : "Link Unavailable"}
        </h1>
        <p className="mt-3 text-sm text-nq-muted">{msg}</p>
      </div>
    </ActionShell>
  );
}

function ActionShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-nq-bg px-4">
      <div className="w-full max-w-sm rounded-2xl border border-nq-border/40 bg-nq-surface p-8">
        {children}
        <p className="mt-8 text-center text-xs text-nq-muted/50">
          Powered by <a href="https://nailiq.ca" className="underline">NailIQ</a>
        </p>
      </div>
    </div>
  );
}
