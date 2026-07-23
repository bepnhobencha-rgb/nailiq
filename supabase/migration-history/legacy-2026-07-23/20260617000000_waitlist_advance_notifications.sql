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
     where nx.id = (select id from public.booking_waitlist_entries
        where salon_id = r.sid and service_id = r.svc and booking_date = r.bd and status = 'waiting'
        order by created_at limit 1 for update skip locked);
    if found then return query select r.sid, r.svc, r.bd,
      (select name from public.salons where id = r.sid), (select name from public.services where id = r.svc);
    end if;
  end loop;
end; $$;
revoke all on function public.advance_waitlist_notifications(int) from public;
grant execute on function public.advance_waitlist_notifications(int) to service_role;
