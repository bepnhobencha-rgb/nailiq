-- Per-salon receptionist / desk module visibility (JSON toggles; owner-editable in app).

alter table public.salons
  add column if not exists dashboard_modules jsonb not null default '{
    "queue_panel": true,
    "quick_add": true,
    "kpi_bar": true,
    "ai_suggestions": false,
    "revenue_today": false,
    "wait_time": true,
    "alerts": true,
    "vip_indicators": true,
    "staff_performance": false,
    "timeline_heatmap": false
  }'::jsonb;

comment on column public.salons.dashboard_modules is
  'Owner-tunable desk module flags; merged with app defaults on read. queue_panel is enforced on in app.';
