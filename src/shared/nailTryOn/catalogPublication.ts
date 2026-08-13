export const MINIMUM_PUBLISHED_NAIL_DESIGNS = 5;

export type NailDesignPublicationInput = {
  id: string;
  name: string;
  description: string | null;
};

export type NailDesignPublicationMapping = {
  designId: string;
  mappingType: "service" | "addon";
  isDefault: boolean;
};

export type NailTryOnCatalogAssessment = {
  ready: boolean;
  designCount: number;
  minimumDesignCount: number;
  missingDescriptionIds: string[];
  missingMainServiceIds: string[];
  missingDefaultServiceIds: string[];
};

/** Pure, deterministic publication gate used by the owner UI and API. */
export function assessNailTryOnCatalog(
  designs: readonly NailDesignPublicationInput[],
  mappings: readonly NailDesignPublicationMapping[],
): NailTryOnCatalogAssessment {
  const byDesign = new Map<string, NailDesignPublicationMapping[]>();
  for (const mapping of mappings) {
    const current = byDesign.get(mapping.designId) ?? [];
    current.push(mapping);
    byDesign.set(mapping.designId, current);
  }

  const missingDescriptionIds: string[] = [];
  const missingMainServiceIds: string[] = [];
  const missingDefaultServiceIds: string[] = [];

  for (const design of designs) {
    if (!design.description?.trim()) missingDescriptionIds.push(design.id);
    const mainMappings = (byDesign.get(design.id) ?? [])
      .filter((mapping) => mapping.mappingType === "service");
    if (!mainMappings.length) missingMainServiceIds.push(design.id);
    if (!mainMappings.some((mapping) => mapping.isDefault)) {
      missingDefaultServiceIds.push(design.id);
    }
  }

  return {
    ready:
      designs.length >= MINIMUM_PUBLISHED_NAIL_DESIGNS
      && missingDescriptionIds.length === 0
      && missingMainServiceIds.length === 0
      && missingDefaultServiceIds.length === 0,
    designCount: designs.length,
    minimumDesignCount: MINIMUM_PUBLISHED_NAIL_DESIGNS,
    missingDescriptionIds,
    missingMainServiceIds,
    missingDefaultServiceIds,
  };
}
