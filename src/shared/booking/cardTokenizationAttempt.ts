/** One in-flight SDK call per mounted form. A later UI context can never
 * receive a result from an earlier quote, customer, consent or form lifetime.
 * This guard stores no source token and makes no provider request itself. */
export function createCardTokenizationAttempt() {
  let context: string | null = null;
  let revision = 0;
  let pending = false;
  return {
    update(next: string | null) {
      if (next !== context) { context = next; revision += 1; }
    },
    async run<T>(expected: string | null, invoke: () => Promise<T>): Promise<T | null> {
      if (expected === null || context !== expected || pending) return null;
      const startedAt = revision;
      pending = true;
      try {
        const result = await invoke();
        return revision === startedAt && context === expected ? result : null;
      } catch (error) {
        // An obsolete SDK failure must not overwrite the new form's state.
        if (revision !== startedAt || context !== expected) return null;
        throw error;
      } finally {
        pending = false;
      }
    },
  };
}
