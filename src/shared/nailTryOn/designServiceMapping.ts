export type MappableService = { id: string; is_addon: boolean };

export function mappingMatchesServices(
  rows: readonly MappableService[],
  serviceId: string | null,
  addonServiceId: string | null,
) {
  return (
    (!serviceId || rows.some((row) => row.id === serviceId && !row.is_addon)) &&
    (!addonServiceId || rows.some((row) => row.id === addonServiceId && row.is_addon))
  );
}
