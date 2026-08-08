-- Opt-in, per-salon rule: appointments starting soon must keep a card on file.
-- NULL means OFF, preserving every existing tenant's behavior. The application
-- clamps writes to the same 1..168 hour range as this database constraint.
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
  'When set, bookings starting within this many hours require a consented card on file for no-show protection. NULL disables the rule.';
