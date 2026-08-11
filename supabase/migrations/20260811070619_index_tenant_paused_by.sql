create index if not exists salons_tenant_paused_by_idx
  on public.salons (tenant_paused_by)
  where tenant_paused_by is not null;
