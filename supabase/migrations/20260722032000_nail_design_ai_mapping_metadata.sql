alter table public.nail_designs
  add column if not exists mapping_status text not null default 'needs_review'
    check (mapping_status in ('ai_suggested', 'ready', 'needs_review')),
  add column if not exists mapping_visual_confidence numeric(4,3),
  add column if not exists mapping_service_confidence numeric(4,3),
  add column if not exists mapping_reason text,
  add column if not exists mapping_attributes jsonb not null default '[]'::jsonb,
  add column if not exists mapping_required_question text;

comment on column public.nail_designs.mapping_status is
  'AI mapping workflow state. ready means owner-confirmed; ai_suggested requires >=90% validated confidence.';
