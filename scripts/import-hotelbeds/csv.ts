/**
 * Review CSV for Hotelbeds rows that match an existing hotel and are not merged.
 */
import type { ReviewMatch } from "./plan";

const COLUMNS = [
  "hotelbeds_code",
  "hotelbeds_name",
  "category_code",
  "star_rating",
  "destination_code",
  "accommodation_type_code",
  "latitude",
  "longitude",
  "website",
  "needs_category_review",
  "existing_hotel_id",
  "existing_hotel_name",
  "existing_latitude",
  "existing_longitude",
  "distance_metres",
  "name_similarity",
] as const;

function csvCell(value: string | number | boolean | null): string {
  const raw = value === null ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function renderMatchesCsv(matches: ReviewMatch[]): string {
  const lines = [COLUMNS.map((column) => csvCell(column)).join(",")];
  for (const match of matches) {
    lines.push(
      [
        match.hotelbedsCode,
        match.hotelbedsName,
        match.categoryCode,
        match.starRating,
        match.destinationCode,
        match.accommodationTypeCode,
        match.latitude,
        match.longitude,
        match.website,
        match.needsCategoryReview,
        match.existingHotelId,
        match.existingHotelName,
        match.existingLatitude,
        match.existingLongitude,
        match.distanceMetres,
        match.nameSimilarity,
      ]
        .map((value) => csvCell(value))
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
