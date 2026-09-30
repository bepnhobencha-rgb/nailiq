export type AutoMappingService = {
  id: string;
  name: string;
  isAddon: boolean;
  category?: string | null;
  description?: string | null;
  priceCents?: number | null;
  durationMinutes?: number | null;
};

export type AutoMappingProposal = {
  bestServiceId: string | null;
  alternativeServiceIds: readonly string[];
  addonServiceIds: readonly string[];
  baseServiceKnown: boolean;
  visualConfidence: number;
  serviceConfidence: number;
  reason: string;
  attributes?: readonly string[];
  requiredQuestion?: string | null;
};

export type AutoMappingResult = {
  serviceIds: string[];
  addonServiceIds: string[];
  defaultServiceId: string | null;
  confidence: number;
  visualConfidence: number;
  serviceConfidence: number;
  baseServiceKnown: boolean;
  reason: string;
  attributes: string[];
  requiredQuestion: string | null;
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

const baseFamilies = ["acrylic", "gel x", "gel-x", "builder", "dip", "sns", "gel", "shellac", "manicure", "pedicure", "polish"] as const;

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function uniqueKnown(ids: readonly string[], allowed: Set<string>, limit: number) {
  return [...new Set(ids)].filter((id) => allowed.has(id)).slice(0, limit);
}

export function sanitizeAutoMapping(proposal: AutoMappingProposal, services: readonly AutoMappingService[]): AutoMappingResult {
  const mainIds = new Set(services.filter((service) => !service.isAddon).map((service) => service.id));
  const addonIds = new Set(services.filter((service) => service.isAddon).map((service) => service.id));
  const bestServiceId = proposal.baseServiceKnown && proposal.bestServiceId && mainIds.has(proposal.bestServiceId) ? proposal.bestServiceId : null;
  const alternatives = uniqueKnown(proposal.alternativeServiceIds, mainIds, 2).filter((id) => id !== bestServiceId);
  const serviceIds = bestServiceId ? [bestServiceId, ...alternatives] : [];
  const addonServiceIds = uniqueKnown(proposal.addonServiceIds, addonIds, 8);
  const visualConfidence = clamp(proposal.visualConfidence);
  const baseServiceKnown = proposal.baseServiceKnown && Boolean(bestServiceId);
  const rawServiceConfidence = clamp(proposal.serviceConfidence);
  const serviceConfidence = baseServiceKnown ? rawServiceConfidence : Math.min(rawServiceConfidence, 0.74);
  const confidence = Math.min(visualConfidence, serviceConfidence);
  const reason = proposal.reason.trim().slice(0, 180) || "NailIQ analyzed the visible design and salon menu.";
  const attributes = [...new Set((proposal.attributes || []).map((value) => value.trim()).filter(Boolean))].slice(0, 10);
  const requiredQuestion = baseServiceKnown
    ? null
    : (proposal.requiredQuestion?.trim().slice(0, 160) || "Do you want this look on natural nails, or with added length?");
  return {
    serviceIds,
    addonServiceIds,
    defaultServiceId: bestServiceId,
    confidence,
    visualConfidence,
    serviceConfidence,
    baseServiceKnown,
    reason,
    attributes,
    requiredQuestion,
    status: baseServiceKnown && confidence >= 0.9 ? "ai_suggested" : "needs_review",
  };
}

export function heuristicAutoMapping(designText: string, services: readonly AutoMappingService[]): AutoMappingResult {
  const text = normalize(designText);
  const main = services.filter((service) => !service.isAddon);
  const addons = services.filter((service) => service.isAddon);
  const attributes = featureTerms.filter((terms) => terms.some((term) => text.includes(normalize(term)))).map((terms) => terms[0]);
  const explicitFamilies = baseFamilies.filter((term) => text.includes(term));
  const scoredMain = main.map((service, index) => {
    const haystack = normalize(`${service.name} ${service.category || ""} ${service.description || ""}`);
    const score = explicitFamilies.reduce((total, term) => total + (haystack.includes(term) ? 4 : 0), 0);
    return { service, score, index };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const best = scoredMain[0];
  const baseServiceKnown = explicitFamilies.length > 0 && Boolean(best?.score);
  const addonServiceIds = addons.filter((service) => {
    const name = normalize(`${service.name} ${service.description || ""}`);
    return featureTerms.some((terms) => terms.some((term) => text.includes(normalize(term))) && terms.some((term) => name.includes(normalize(term))));
  }).map((service) => service.id);
  return sanitizeAutoMapping({
    bestServiceId: baseServiceKnown ? best.service.id : null,
    alternativeServiceIds: [],
    addonServiceIds,
    baseServiceKnown,
    visualConfidence: attributes.length ? 0.78 : 0.55,
    serviceConfidence: baseServiceKnown ? 0.9 : 0.4,
    reason: baseServiceKnown
      ? "The design text explicitly names a base service available in this salon."
      : "The visible style is clear, but the image cannot identify the underlying nail system.",
    attributes,
    requiredQuestion: baseServiceKnown ? null : "Natural nails or extensions—and if extensions, which system do you prefer?",
  }, services);
}
