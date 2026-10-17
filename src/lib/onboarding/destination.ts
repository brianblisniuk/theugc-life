/**
 * Destination question (D095). Chips are catalog matches, never invented places.
 * Search only narrows destinations that already exist.
 */
import { isUuid } from "@/lib/hotels/ids";

export interface DestinationChoice {
  id: string;
  name: string;
  slug: string;
  countryCode: string | null;
}

export function foldDestination(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** Bali, México, and Japón when the catalog has them. Order follows the needles. */
export function suggestedChips(destinations: readonly DestinationChoice[]): DestinationChoice[] {
  const chips: DestinationChoice[] = [];
  const used = new Set<string>();
  const groups = [["bali"], ["mexico", "méxico"], ["japon", "japón"]];
  for (const group of groups) {
    const match = destinations.find((destination) => {
      if (used.has(destination.id)) return false;
      const name = foldDestination(destination.name);
      return group.some(
        (needle) => name === foldDestination(needle) || name.includes(foldDestination(needle)),
      );
    });
    if (match) {
      used.add(match.id);
      chips.push(match);
    }
  }
  return chips;
}

export function filterDestinations(
  destinations: readonly DestinationChoice[],
  query: string,
): DestinationChoice[] {
  const needle = foldDestination(query);
  if (!needle) return destinations.slice(0, 12);
  return destinations
    .filter((destination) => foldDestination(destination.name).includes(needle))
    .slice(0, 12);
}

export function nearbyDestinations(
  destinations: readonly DestinationChoice[],
  currentId: string | null,
): DestinationChoice[] {
  const current = destinations.find((destination) => destination.id === currentId) ?? null;
  const sameCountry =
    current?.countryCode != null
      ? destinations.filter(
          (destination) =>
            destination.id !== current.id && destination.countryCode === current.countryCode,
        )
      : [];
  const pool =
    sameCountry.length > 0
      ? sameCountry
      : destinations.filter((destination) => destination.id !== currentId);
  return pool.slice(0, 6);
}

export function isDestinationId(value: string): boolean {
  return isUuid(value);
}

/** A chip is a catalog id. Leaving the page with one selected must write it first. */
export function shouldPersistDestinationBeforeLeave(selectedId: string): boolean {
  return isDestinationId(selectedId);
}

export type DestinationWrite = { error: string } | { ok: true };

/**
 * Serializes destination writes. A newer selection skips an older one that has
 * not started, and a write that already started finishes before the next one,
 * so the last chip the creator picked is the row that remains.
 */
export function createDestinationSaveQueue(write: (id: string) => Promise<DestinationWrite>) {
  let tail: Promise<void> = Promise.resolve();
  let latest = "";
  return {
    enqueue(id: string): Promise<DestinationWrite> {
      latest = id;
      const run = tail.then(() => {
        if (latest !== id) return { ok: true as const };
        return write(id);
      });
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}
