-- Waitlist attention pilot: allow authenticated salon members to receive
-- booking_waitlist_entries changes through the existing Supabase Realtime
-- channel. The table already has RLS and a salon_members-scoped SELECT policy.
-- UI behavior remains OFF unless the per-salon release flag is enabled.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'booking_waitlist_entries'
  ) then
    alter publication supabase_realtime
      add table public.booking_waitlist_entries;
  end if;
end
$$;
