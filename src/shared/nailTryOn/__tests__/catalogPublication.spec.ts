import { describe, expect, it } from "vitest";
import {
  assessNailTryOnCatalog,
  MINIMUM_PUBLISHED_NAIL_DESIGNS,
  type NailDesignPublicationMapping,
} from "@/shared/nailTryOn/catalogPublication";

function design(id: string, description = `Description ${id}`) {
  return { id, name: `Design ${id}`, description };
}

function readyMappings(ids: string[]): NailDesignPublicationMapping[] {
  return ids.map((designId) => ({
    designId,
    mappingType: "service" as const,
    isDefault: true,
  }));
}

describe("Nail Try-On catalog publication", () => {
  const ids = ["1", "2", "3", "4", "5"];

  it("requires at least five complete designs", () => {
    const designs = ids.slice(0, 4).map((id) => design(id));
    const result = assessNailTryOnCatalog(
      designs,
      readyMappings(ids.slice(0, 4)),
    );

    expect(result.ready).toBe(false);
    expect(result.designCount).toBe(4);
    expect(result.minimumDesignCount).toBe(MINIMUM_PUBLISHED_NAIL_DESIGNS);
  });

  it("rejects blank descriptions", () => {
    const designs = ids.map((id) => design(id, id === "3" ? "  " : `D ${id}`));
    const result = assessNailTryOnCatalog(designs, readyMappings(ids));

    expect(result.ready).toBe(false);
    expect(result.missingDescriptionIds).toEqual(["3"]);
  });

  it("requires a main service and one default per design", () => {
    const mappings = readyMappings(ids).filter(
      (row) => !["4", "5"].includes(row.designId),
    );
    mappings.push({ designId: "4", mappingType: "addon", isDefault: false });
    mappings.push({ designId: "5", mappingType: "service", isDefault: false });

    const result = assessNailTryOnCatalog(
      ids.map((id) => design(id)),
      mappings,
    );

    expect(result.ready).toBe(false);
    expect(result.missingMainServiceIds).toEqual(["4"]);
    expect(result.missingDefaultServiceIds).toEqual(["4", "5"]);
  });

  it("allows publication only when every requirement passes", () => {
    const result = assessNailTryOnCatalog(
      ids.map((id) => design(id)),
      readyMappings(ids),
    );

    expect(result).toMatchObject({
      ready: true,
      designCount: 5,
      missingDescriptionIds: [],
      missingMainServiceIds: [],
      missingDefaultServiceIds: [],
    });
  });
});
