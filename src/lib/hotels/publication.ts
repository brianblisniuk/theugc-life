/**
 * Which canonical hotel rows Discover and Hotel Detail may render (D062, D054, D060).
 *
 * A row in `hotels` is the publication boundary (D062): there is no
 * unpublished-canonical status column. Rows promoted before that contract can
 * still sit in the table without meeting it. This predicate is the product
 * read path's check of the conditions that are columns on `hotels`:
 *
 * - a canonical destination (D062.2; the column is already NOT NULL)
 * - hospitality classification exactly 4 or 5 — never a fractional review score,
 *   never an average (D060, D062.6)
 * - canonical latitude and longitude inside the geographic ranges (D054, D062.8–9)
 * - not known permanently closed (D062.4). `unknown` stays visible: A05 publishes
 *   that status because "no known closure" is not evidence the property is open,
 *   and it is not evidence the property is inactive either.
 *
 * Star and coordinate provenance live on the publication receipt, which creators
 * cannot read. This block does not add a migration to expose that receipt.
 * `closed` is the inactive status and is never rendered. `temporarily_closed`
 * is not permanent closure and stays visible with its own label.
 */

export const PUBLISHED_STAR_RATINGS = [4, 5] as const;

/** Statuses that are not "known permanently closed". */
export const PUBLISHED_ACTIVE_STATUSES = ["active", "temporarily_closed", "unknown"] as const;

export const PUBLISHED_CANONICAL_HOTEL_WHERE = `
  destination_id is not null
  and star_rating in (4, 5)
  and latitude >= -90 and latitude <= 90
  and longitude >= -180 and longitude <= 180
  and active_status in ('active', 'temporarily_closed', 'unknown')
`;

export interface PublicationFacts {
  destinationId: string | null;
  starRating: number | null;
  latitude: number | null;
  longitude: number | null;
  activeStatus: string | null;
}

export function isCanonicalCoordinate(latitude: number | null, longitude: number | null): boolean {
  if (latitude === null || longitude === null) return false;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

export function isPublishedStarRating(rating: number | null): boolean {
  return rating === 4 || rating === 5;
}

export function isPublishedCanonicalHotel(facts: PublicationFacts): boolean {
  if (!facts.destinationId) return false;
  if (!isPublishedStarRating(facts.starRating)) return false;
  if (!isCanonicalCoordinate(facts.latitude, facts.longitude)) return false;
  return (
    facts.activeStatus !== null &&
    (PUBLISHED_ACTIVE_STATUSES as readonly string[]).includes(facts.activeStatus)
  );
}

/**
 * Hospitality classification label. A missing or non-integer rating is not
 * rendered as zero stars and is not rounded into a guest-review score (D060).
 */
export function hospitalityClassificationLabel(rating: number | null): string | null {
  if (!isPublishedStarRating(rating)) return null;
  return `${rating}-star hospitality classification`;
}
