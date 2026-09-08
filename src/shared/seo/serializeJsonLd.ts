/**
 * Serialize structured data for an inline non-executable JSON-LD script.
 * Escaping `<` prevents user-controlled salon text from closing the script
 * element while preserving the parsed JSON value.
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
