import type { Translation } from "./providerCatalog";
import { translationResultKey } from "./providerCatalog";

// Event delivery and IPC replies can arrive out of order within the same batch.
// Each model has one terminal result, so an older snapshot must never erase it.
export function mergeTranslationSnapshot(current: Translation | null, incoming: Translation): Translation {
  if (!current || current.requestId !== incoming.requestId) return incoming;
  const previous = new Map(current.results.map((result) => [translationResultKey(result), result]));
  const results = incoming.results.map((result) => {
    const existing = previous.get(translationResultKey(result));
    return existing && (existing.translation || existing.error) ? existing : result;
  });
  const unchanged = current.source === incoming.source && results.length === current.results.length
    && results.every((result, index) => {
      const previous = current.results[index];
      return translationResultKey(previous) === translationResultKey(result)
        && previous.translation === result.translation && previous.error === result.error;
    });
  return unchanged ? current : { ...incoming, results };
}
