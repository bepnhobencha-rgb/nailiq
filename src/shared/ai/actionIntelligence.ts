export type ActionIntelligence = {
  reason: string;
  evidence: string[];
  impact: string;
  confidence: { label: string; percent: number | null };
  reversibility: { label: string; reversible: boolean | null };
};

type Language = "en" | "vi";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function firstText(
  payload: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function evidenceList(payload: Record<string, unknown>): string[] {
  const raw = payload.evidence ?? payload.signals ?? payload.sources;
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (!isRecord(item)) return "";
      return firstText(item, ["label", "summary", "value", "source"]) ?? "";
    })
    .filter(Boolean)
    .slice(0, 4);
}

function confidenceValue(payload: Record<string, unknown>): number | null {
  const raw = payload.confidence ?? payload.confidence_score;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const normalized = raw <= 1 ? raw * 100 : raw;
    return Math.max(0, Math.min(100, Math.round(normalized)));
  }
  if (typeof raw === "string") {
    const parsed = Number.parseFloat(raw.replace("%", ""));
    if (Number.isFinite(parsed)) {
      const normalized = parsed <= 1 ? parsed * 100 : parsed;
      return Math.max(0, Math.min(100, Math.round(normalized)));
    }
  }
  return null;
}

function impactFallback(
  actionType: string,
  payload: Record<string, unknown>,
  language: Language,
): string | null {
  const recipients = payload.recipients;
  if (Array.isArray(recipients)) {
    return language === "vi"
      ? `Hành động sẽ liên hệ ${recipients.length} khách hàng.`
      : `This action will contact ${recipients.length} customers.`;
  }

  const amount = payload.amountCents ?? payload.amount_cents;
  if (typeof amount === "number" && Number.isFinite(amount)) {
    return language === "vi"
      ? `Hành động liên quan đến khoản tiền ${(amount / 100).toFixed(2)} theo đơn vị tiền tệ của tiệm.`
      : `This action involves ${(amount / 100).toFixed(2)} in the salon's configured currency.`;
  }

  const known: Record<string, { en: string; vi: string }> = {
    price_change: {
      en: "This changes pricing or a promotion visible to customers.",
      vi: "Hành động này thay đổi giá hoặc khuyến mãi khách hàng nhìn thấy.",
    },
    bulk_message: {
      en: "This sends a message to multiple customers.",
      vi: "Hành động này gửi thông báo đến nhiều khách hàng.",
    },
    charge_noshow: {
      en: "This may charge a customer for a no-show.",
      vi: "Hành động này có thể tính phí no-show cho khách hàng.",
    },
  };
  return known[actionType]?.[language] ?? null;
}

function reversibilityValue(
  actionType: string,
  payload: Record<string, unknown>,
): boolean | null {
  const explicit = payload.reversible ?? payload.can_undo;
  if (typeof explicit === "boolean") return explicit;
  if (["send_us_sms", "bulk_message", "charge_noshow"].includes(actionType)) {
    return false;
  }
  return null;
}

export function buildActionIntelligence(
  actionType: string,
  payloadValue: unknown,
  language: Language,
): ActionIntelligence {
  const payload = isRecord(payloadValue) ? payloadValue : {};
  const confidence = confidenceValue(payload);
  const reversible = reversibilityValue(actionType, payload);

  const reason =
    firstText(payload, ["reason", "rationale", "why", "trigger_summary"]) ??
    (language === "vi"
      ? "AI chưa cung cấp lý do có cấu trúc cho đề xuất này."
      : "AI did not provide a structured reason for this recommendation.");

  const evidence = evidenceList(payload);
  if (evidence.length === 0) {
    evidence.push(
      language === "vi"
        ? "Chưa có bằng chứng được đính kèm."
        : "No supporting evidence was attached.",
    );
  }

  const impact =
    firstText(payload, ["expected_impact", "impact", "impact_summary"]) ??
    impactFallback(actionType, payload, language) ??
    (language === "vi"
      ? "AI chưa định lượng tác động dự kiến."
      : "AI did not quantify the expected impact.");

  return {
    reason,
    evidence,
    impact,
    confidence: {
      percent: confidence,
      label:
        confidence == null
          ? language === "vi"
            ? "Chưa đánh giá"
            : "Not assessed"
          : `${confidence}%`,
    },
    reversibility: {
      reversible,
      label:
        reversible === true
          ? language === "vi"
            ? "Có thể hoàn tác"
            : "Reversible"
          : reversible === false
            ? language === "vi"
              ? "Không thể hoàn tác tự động"
              : "No automatic undo"
            : language === "vi"
              ? "Chưa xác định"
              : "Not specified",
    },
  };
}
