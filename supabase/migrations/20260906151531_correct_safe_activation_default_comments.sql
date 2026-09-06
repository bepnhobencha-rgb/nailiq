-- Keep database metadata aligned with the safe defaults introduced for new
-- salon workspaces. This changes comments only and never rewrites salon rows.
--
-- Rollback: restore the prior comments that described these defaults as true.

COMMENT ON COLUMN public.salons.email_links_enabled IS
  'When enabled by the Owner, desk-sent links can also be emailed when an address is on file. Defaults OFF for new salons.';

COMMENT ON COLUMN public.salons.winback_enabled IS
  'When enabled by the Owner, eligible no-shows can enter the win-back workflow. Defaults OFF for new salons.';
