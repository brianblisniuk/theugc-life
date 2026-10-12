import { ShareMarkButton } from "@/components/profile/share-mark-button";

export interface ContentExampleRow {
  id: string;
  label: string;
  platform: string | null;
  proofUrl: string | null;
}

export function ContentExamples({
  deliverables,
  sharedIds,
}: {
  deliverables: ContentExampleRow[];
  sharedIds: string[];
}) {
  const shared = new Set(sharedIds);
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-text">Content examples</h2>
        <p className="max-w-prose text-sm text-muted">
          Only an example you mark, and only when it has an https proof link, can appear on the
          hotel link. Notes stay private.
        </p>
      </div>
      {deliverables.length === 0 ? (
        <p className="max-w-prose text-sm text-muted">No deliverables recorded yet.</p>
      ) : (
        <ul className="space-y-3">
          {deliverables.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius-app)] border border-border bg-surface p-4"
            >
              <div className="space-y-1">
                <h3 className="text-base font-semibold text-text">{item.label}</h3>
                <p className="text-sm text-muted">{item.platform ?? "Platform not recorded"}</p>
                {item.proofUrl ? (
                  <p className="break-all text-xs text-muted">{item.proofUrl}</p>
                ) : (
                  <p className="text-xs text-muted">
                    Add an https proof link on the collaboration before this can appear.
                  </p>
                )}
              </div>
              {item.proofUrl ? (
                <ShareMarkButton id={item.id} shared={shared.has(item.id)} kind="deliverable" />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
