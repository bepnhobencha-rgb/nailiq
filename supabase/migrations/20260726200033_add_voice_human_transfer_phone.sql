begin;

alter table public.salons
  add column if not exists voice_ai_transfer_phone text;

alter table public.salons
  drop constraint if exists salons_voice_ai_transfer_phone_e164_check;

alter table public.salons
  add constraint salons_voice_ai_transfer_phone_e164_check
  check (
    voice_ai_transfer_phone is null
    or voice_ai_transfer_phone ~ '^\+[1-9][0-9]{7,14}$'
  );

comment on column public.salons.voice_ai_transfer_phone is
  'Optional E.164 destination for live AI receptionist handoff. Kept separate from the public salon phone and owner alert phone to prevent transfer loops and accidental exposure.';

commit;
