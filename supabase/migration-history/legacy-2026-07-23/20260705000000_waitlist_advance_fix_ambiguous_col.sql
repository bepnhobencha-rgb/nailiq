-- Fix: `advance_waitlist_notifications` raised Postgres 42702
-- ("column reference \"salon_id\" is ambiguous") whenever it actually had work
-- to do. The function's RETURNS TABLE(...) output columns are named `salon_id`,
-- `service_id`, `booking_date` — the SAME names used, unqualified, inside the
-- next-in-line subquery. PL/pgSQL couldn't tell the OUT-parameter from the table
-- column, so the moment an expired 'notified' entry entered the loop body the
-- RPC threw and the cron 500'd. Net effect: the waitlist claim-window auto-
-- advance never promoted anyone once a link expired (it only "succeeded" when
-- there was nothing to do and the loop body never ran).
--
-- Fix: alias the inner table (`bw`) and fully qualify every column reference so
-- none collide with the output-column names. Pure logic-preserving rewrite —
-- no behavioural change beyond no longer erroring.
create or replace function public.advance_waitlist_notifications(p_window_minutes int default 20)
returns table (salon_id uuid, service_id uuid, booking_date date, salon_name text, service_name text)
language plpgsql security definer set search_path = public
as $$
declare r record;
begin
  for r in
    update public.booking_waitlist_entries w set status = 'expired'
     where w.status = 'notified' and w.claimed_at is null
       and w.notified_at < now() - make_interval(mins => p_window_minutes)
    returning w.salon_id as sid, w.service_id as svc, w.booking_date as bd
  loop
    update public.booking_waitlist_entries nx
       set status = 'notified', notified_at = now(), claim_token = gen_random_uuid()
     where nx.id = (select bw.id from public.booking_waitlist_entries bw
        where bw.salon_id = r.sid and bw.service_id = r.svc and bw.booking_date = r.bd
          and bw.status = 'waiting'
        order by bw.created_at limit 1 for update skip locked);
    if found then return query select r.sid, r.svc, r.bd,
      (select s.name from public.salons s where s.id = r.sid),
      (select sv.name from public.services sv where sv.id = r.svc);
    end if;
  end loop;
end; $$;
revoke all on function public.advance_waitlist_notifications(int) from public;
grant execute on function public.advance_waitlist_notifications(int) to service_role;
