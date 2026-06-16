import { SuperadminSignOutButton } from "@/components/superadmin/SuperadminSignOutButton";

/**
 * Slim mobile-only (<md) top bar for the superadmin shell.
 *
 * Shows the "NailIQ SuperAdmin" wordmark on the left and a sign-out
 * button on the right. Hidden at `md` and above where the sidebar takes
 * over (sidebar footer carries the sign-out there).
 *
 * Server component — `SuperadminSignOutButton` is the only interactive
 * piece and it carries its own "use client" boundary.
 */
export function SuperadminTopBar() {
  return (
    <div className="md:hidden sticky top-0 z-30 flex items-center justify-between border-b border-nq-border/40 bg-nq-surface/90 px-4 py-2 backdrop-blur">
      <span className="inline-flex items-baseline gap-0 font-bold tracking-[-0.02em] leading-none text-base select-none">
        <span className="text-white">Nail</span>
        <span className="text-nq-primary">IQ</span>
        <span className="ml-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-nq-muted">
          SuperAdmin
        </span>
      </span>
      <SuperadminSignOutButton />
    </div>
  );
}
