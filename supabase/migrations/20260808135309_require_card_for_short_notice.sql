-- Opt-in, per-salon short-notice card rule. NULL preserves all existing behavior.
alter table public.salons
  add column if not exists noshow_short_notice_hours integer;

alter table public.salons
  drop constraint if exists salons_noshow_short_notice_hours_check;

alter table public.salons
  add constraint salons_noshow_short_notice_hours_check
  check (
    noshow_short_notice_hours is null
    or noshow_short_notice_hours between 1 and 168
  );

comment on column public.salons.noshow_short_notice_hours is
  'Optional rolling window in hours. Future appointments at or inside this window require a no-show card. NULL disables the rule.';
