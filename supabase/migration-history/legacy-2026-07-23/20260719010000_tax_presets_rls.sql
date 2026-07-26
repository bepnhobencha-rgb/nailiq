-- Security fix: tax_presets had RLS disabled — anyone with the anon key could
-- read AND write every row (Supabase advisor: rls_disabled, critical).
--
-- tax_presets is platform reference data (tax rates per region label):
--   • readable by everyone (booking page + dashboard need it)
--   • writable ONLY via service-role (bypasses RLS), same as platform_settings.
alter table public.tax_presets enable row level security;

drop policy if exists "tax_presets_read_all" on public.tax_presets;
create policy "tax_presets_read_all"
  on public.tax_presets
  for select
  to anon, authenticated
  using (true);

-- No insert/update/delete policies on purpose: client-side writes are blocked;
-- backend code uses the service-role key which bypasses RLS.
