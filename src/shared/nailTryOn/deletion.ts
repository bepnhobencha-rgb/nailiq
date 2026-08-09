export type NailTryOnDeletionPathsInput = {
  salonId: string;
  sessionId: string;
  sourceImagePath: string;
  resultImagePath?: string | null;
};

/**
 * Include the deterministic preview path even when generation has not stored it
 * on the session yet. A customer can delete while an image edit is in flight;
 * queueing this path prevents that late result from surviving the request.
 */
export function nailTryOnDeletionPaths(input: NailTryOnDeletionPathsInput) {
  return [...new Set([
    input.sourceImagePath,
    input.resultImagePath,
    `salon/${input.salonId}/session/${input.sessionId}/preview.jpg`,
  ].filter((path): path is string => Boolean(path)))];
}
