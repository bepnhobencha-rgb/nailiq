-- Voice AI upsell: after a caller picks a service, the receptionist may offer ONE
-- tasteful upgrade/combo from the salon's own menu. Off is a per-salon choice, so
-- it is a toggle (default ON — owners who added the AI receptionist want revenue).
alter table public.salons
  add column if not exists voice_ai_upsell_enabled boolean not null default true;

comment on column public.salons.voice_ai_upsell_enabled is
  'When true, the voice/web receptionist offers one tasteful upsell after a service is chosen.';
