/**
 * Designed no-photo state (D064, VISUAL_DIRECTION §20).
 *
 * Photo coverage is not publishability. This is not a loading skeleton and not
 * a stand-in image. No URL is requested.
 */
export function NoPhoto({ name }: { name: string }) {
  const mark = name.trim().charAt(0).toUpperCase() || "·";
  return (
    <div className="flex h-16 w-full items-center justify-center border border-border bg-background">
      <span className="text-sm font-semibold text-text" aria-hidden="true">
        {mark}
      </span>
      <span className="sr-only">No photograph for {name}</span>
    </div>
  );
}
