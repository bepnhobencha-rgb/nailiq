export type MappableService = { id: string; is_addon: boolean };

export type NailDesignServiceMappingInput = {
  serviceIds: readonly string[];
  addonServiceIds: readonly string[];
  defaultServiceId: string | null;
};

export function mappingMatchesServices(
  rows: readonly MappableService[],
  mapping: NailDesignServiceMappingInput,
) {
  const serviceIds = [...new Set(mapping.serviceIds)];
  const addonServiceIds = [...new Set(mapping.addonServiceIds)];
  return (
    serviceIds.length === mapping.serviceIds.length &&
    addonServiceIds.length === mapping.addonServiceIds.length &&
    (!mapping.defaultServiceId || serviceIds.includes(mapping.defaultServiceId)) &&
    serviceIds.every((id) => rows.some((row) => row.id === id && !row.is_addon)) &&
    addonServiceIds.every((id) => rows.some((row) => row.id === id && row.is_addon))
  );
}
