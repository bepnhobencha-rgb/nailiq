export type AutoMappingService = {
  id: string;
  name: string;
  isAddon: boolean;
  priceCents?: number | null;
  durationMinutes?: number | null;
};

export type AutoMappingProposal = {
  serviceIds: readonly string[];
  addonServiceIds: readonly string[];
  defaultServiceId: string | null;
  confidence: number;
  reason: string;
  attributes?: readonly string[];
};

export type AutoMappingResult = {
  serviceIds: string[];
  addonServiceIds: string[];
  defaultServiceId: string | null;
  confidence: number;
  reason: string;
  attributes: string[];
  status: "ai_suggested" | "ready" | "needs_review";
};

const featureTerms = [
  ["french", "tip", "tips", "đầu trắng"],
  ["chrome", "mirror", "tráng gương"],
  ["ombre", "ombré", "gradient", "loang"],
  ["rhinestone", "crystal", "gem", "stone", "đính đá"],
  ["art", "design", "hand painted", "vẽ", "trang trí"],
  ["long", "xl", "xxl", "extension", "extra length", "móng dài"],
  ["almond", "coffin", "stiletto", "ballerina", "square", "oval", "shape"],
] as const;

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function uniqueKnown(ids: readonly string[], allowed: Set<string>) {
  return [...new Set(ids)].filter((id) => allowed.has(id));
}

export function sanitizeAutoMapping(
  proposal: AutoMappingProposal,
  services: readonly AutoMappingService[],
): AutoMappingResult {
  const mainIds = new Set(services.filter((service) => !service.isAddon).map((service) => service.id));
  const addonIds = new Set(services.filter((service) => service.isAddon).map((service) => service.id));
  const serviceIds = uniqueKnown(proposal.serviceIds, mainIds);
  const addonServiceIds = uniqueKnown(proposal.addonServiceIds, addonIds);
  const defaultServiceId = proposal.defaultServiceId && serviceIds.includes(proposal.defaultServiceId)
    ? proposal.defaultServiceId
    : serviceIds[0] || null;
  const confidence = Math.max(0, Math.min(1, Number.isFinite(proposal.confidence) ? proposal.confidence : 0));
  const reason = proposal.reason.trim().slice(0, 240) || "AI matched this design against the salon menu.";
  const attributes = [...new Set((proposal.attributes || []).map((value) => value.trim()).filter(Boolean))].slice(0, 12);
  return {
    serviceIds,
    addonServiceIds,
    defaultServiceId,
    confidence,
    reason,
    attributes,
    status: serviceIds.length > 0 && confidence >= 0.72 ? "ai_suggested" : "needs_review",
  };
}

export function heuristicAutoMapping(
  designText: string,
  services: readonly AutoMappingService[],
): AutoMappingResult {
  const text = normalize(designText);
  const main = services.filter((service) => !service.isAddon);
  const addons = services.filter((service) => service.isAddon);
  const attributes = featureTerms
    .filter((terms) => terms.some((term) => text.includes(normalize(term))))
    .map((terms) => terms[0]);
  const scoredMain = main.map((service, index) => {
    const name = normalize(service.name);
    let score = 0;
    for (const term of ["acrylic", "gel x", "gel-x", "builder", "dip", "sns", "gel", "shellac", "manicure", "pedicure", "polish"]) {
      if (text.includes(term) && name.includes(term)) score += 4;
    }
    if (!text.includes("toe") && !text.includes("pedi") && name.includes("manicure")) score += 1;
    return { service, score, index };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const bestScore = scoredMain[0]?.score || 0;
  const hasStrongMatch = bestScore >= 4;
  const serviceIds = scoredMain.filter((item) => hasStrongMatch && item.score === bestScore).map((item) => item.service.id);
  const fallback = serviceIds.length ? serviceIds : (main[0] ? [main[0].id] : []);
  const addonServiceIds = addons.filter((service) => {
    const name = normalize(service.name);
    return featureTerms.some((terms) => terms.some((term) => text.includes(normalize(term))) && terms.some((term) => name.includes(normalize(term))));
  }).map((service) => service.id);
  const confidence = hasStrongMatch ? 0.74 : 0.45;
  return {
    serviceIds: fallback,
    addonServiceIds,
    defaultServiceId: fallback[0] || null,
    confidence,
    reason: hasStrongMatch
      ? "Matched the design description to the closest services in this salon's menu."
      : "No strong service match was found; the first available service needs owner review.",
    attributes,
    status: hasStrongMatch && fallback.length > 0 ? "ai_suggested" : "needs_review",
  };
}
