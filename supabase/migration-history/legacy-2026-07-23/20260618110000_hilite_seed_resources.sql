-- Seed 7 beds for Hi-Lite Head Spa (head_spa vertical) and enable the resource layer.
-- Idempotent: ON CONFLICT DO NOTHING prevents duplicates on re-run.

do $$
declare
  v_salon_id uuid;
begin
  select id into v_salon_id
  from public.salons
  where slug = 'hilite-anaheim'
  limit 1;

  if v_salon_id is null then
    raise notice 'hilite-anaheim salon not found — skipping resource seed';
    return;
  end if;

  insert into public.salon_resources (salon_id, name, kind, display_order, status)
  values
    (v_salon_id, 'Bed 1', 'bed', 1, 'active'),
    (v_salon_id, 'Bed 2', 'bed', 2, 'active'),
    (v_salon_id, 'Bed 3', 'bed', 3, 'active'),
    (v_salon_id, 'Bed 4', 'bed', 4, 'active'),
    (v_salon_id, 'Bed 5', 'bed', 5, 'active'),
    (v_salon_id, 'Bed 6', 'bed', 6, 'active'),
    (v_salon_id, 'Bed 7', 'bed', 7, 'active')
  on conflict do nothing;

  update public.salons
  set resources_enabled  = true,
      primary_grid_axis  = 'resource'
  where id = v_salon_id;

  raise notice 'Hi-Lite resources seeded and resources_enabled=true';
end $$;
