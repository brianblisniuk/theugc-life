/**
 * Map slot (E01). No map provider is decided, so this surface does not load
 * tiles, does not embed a map, and does not send coordinates anywhere.
 * The slot is the place a map will go. It is not an unmapped-hotel state:
 * published hotels have coordinates (D054); the provider does not exist yet.
 */
export function MapSlot() {
  return (
    <aside
      aria-label="Map"
      className="border border-border bg-background px-4 py-4 lg:sticky lg:top-4"
    >
      <h2 className="text-sm font-semibold text-text">Map</h2>
      <p className="mt-2 text-sm text-muted">
        No map is shown. A map provider has not been chosen, and hotel coordinates are not sent to
        one.
      </p>
    </aside>
  );
}
