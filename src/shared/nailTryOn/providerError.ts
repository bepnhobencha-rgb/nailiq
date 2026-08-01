export type SafeProviderError = {
  code: "provider_auth" | "provider_access" | "provider_rate_limit" | "provider_timeout" | "provider_unavailable" | "generation_failed";
  status: number | null;
  providerCode: string | null;
  providerType: string | null;
  requestId: string | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function safeString(value: unknown, max = 80): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}

/** Extracts operational metadata without logging prompts, images, headers, or secrets. */
export function safeProviderError(error: unknown): SafeProviderError {
  const source = record(error);
  const status = typeof source.status === "number" ? source.status : null;
  const providerCode = safeString(source.code);
  const providerType = safeString(source.type);
  const requestId = safeString(source.request_id ?? source.requestId, 120);

  const constructorName = error instanceof Error ? error.constructor.name : "";
  let code: SafeProviderError["code"] = "generation_failed";
  if (status === 401) code = "provider_auth";
  else if (status === 403 || status === 404) code = "provider_access";
  else if (status === 408) code = "provider_timeout";
  else if (constructorName === "APIConnectionTimeoutError" || providerCode === "ETIMEDOUT") code = "provider_timeout";
  else if (status === 429) code = "provider_rate_limit";
  else if (status !== null && status >= 500) code = "provider_unavailable";

  return { code, status, providerCode, providerType, requestId };
}
