-- Group no-show protection mode.
--
-- A group books as one party but each member is a separate `bookings` row, and
-- only the ORGANIZER leaves a card. Previously the organizer's no-show fee was
-- only 20% of THEIR OWN service — so if the whole party ghosted (the costliest
-- kind of no-show: many slots lost) the salon could only recover one person's
-- fee. When `noshow_group_whole_party` is on (default), the organizer's single
-- card on file covers the no-show fee for the ENTIRE party (% of the group
-- total) — strong protection, one card, low friction.
--
-- Off → per-person (legacy): the organizer is only on the hook for their own
-- service.

alter table public.salons
  add column if not exists noshow_group_whole_party boolean not null default true;

comment on column public.salons.noshow_group_whole_party is
  'When true (default), a group organizer''s card-on-file no-show fee is a % of '
  'the WHOLE party total (one card protects the whole group). When false, only '
  'the organizer''s own service.';
