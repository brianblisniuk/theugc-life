/**
 * The only hotel fields a map pin may carry (D054, D049, D079).
 *
 * A pin is a published hotel's public location. It is not a card, not a
 * contact, and not the viewer's pipeline or trip. Copying through this
 * function drops anything else that was on the row.
 */

export const PUBLIC_MAP_PIN_FIELDS = ["id", "name", "latitude", "longitude"] as const;

export interface PublicMapPin {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

export function publicMapPin(input: PublicMapPin): PublicMapPin {
  return {
    id: input.id,
    name: input.name,
    latitude: input.latitude,
    longitude: input.longitude,
  };
}
