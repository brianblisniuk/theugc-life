import Link from "next/link";

import type { PipelineListItem } from "@/lib/pipeline/queries";
import { PIPELINE_STATUSES, type PipelineStatus } from "@/lib/pipeline/types";
import { pipelineRowLinks, type PipelineSurface } from "@/lib/shell/navigation";

const COLUMNS: { status: PipelineStatus; label: string; tone: "ink" | "follow" | "won" }[] = [
  { status: "saved", label: "Guardado", tone: "ink" },
  { status: "planned", label: "Planeado", tone: "ink" },
  { status: "pitched", label: "Enviado", tone: "ink" },
  { status: "follow_up", label: "Seguimiento", tone: "follow" },
  { status: "replied", label: "Respondió", tone: "ink" },
  { status: "negotiating", label: "Negociando", tone: "ink" },
  { status: "won", label: "Ganado", tone: "won" },
  { status: "closed", label: "Cerrado", tone: "ink" },
];

function whenLabel(item: PipelineListItem): string | null {
  if (item.nextFollowupAt) return `seguimiento ${item.nextFollowupAt.slice(0, 10)}`;
  if (item.savedAt) return `guardado ${item.savedAt.slice(0, 10)}`;
  return null;
}

export function PipelineBoard({
  items,
  surface,
}: {
  items: readonly PipelineListItem[];
  surface: PipelineSurface;
}) {
  const known = new Set<string>(PIPELINE_STATUSES);
  return (
    <div className="flex gap-3 overflow-x-auto pb-2 md:grid md:grid-cols-4 md:overflow-visible xl:grid-cols-8">
      {COLUMNS.map((column) => {
        const rows = items.filter((item) => item.status === column.status);
        const border = column.tone === "won" ? "border-[#0b6b4b]" : "border-[#111]";
        return (
          <section key={column.status} className="w-44 shrink-0 md:w-auto md:min-w-0 md:shrink">
            <h3
              className={`flex justify-between border-b-[3px] py-2 text-xs font-bold uppercase tracking-wider ${border}`}
            >
              {column.label} <em className="font-normal not-italic text-[#555]">{rows.length}</em>
            </h3>
            {rows.length === 0 ? (
              <p className="px-1 py-2 text-sm text-[#999]">—</p>
            ) : (
              rows.map((item) => {
                const href = pipelineRowLinks(
                  {
                    status: item.status,
                    hotelId: item.hotel?.id ?? null,
                    hotelName: item.hotel?.name,
                  },
                  surface,
                )[0]?.href;
                const accent =
                  column.tone === "follow"
                    ? "border-l-4 border-l-[#e8590c]"
                    : column.tone === "won"
                      ? "border-l-4 border-l-[#0b6b4b]"
                      : "";
                const body = (
                  <>
                    <b>{item.hotel?.name ?? "Hotel"}</b>
                    <small className="block text-[#555]">{item.hotel?.destinationName ?? ""}</small>
                    {whenLabel(item) ? (
                      <span className="mt-2 block text-xs font-semibold text-[#555]">
                        {whenLabel(item)}
                      </span>
                    ) : null}
                    {item.deadlineLabel ? (
                      <span
                        className="mt-1 block text-xs font-semibold text-[#111]"
                        data-testid="pipeline-deadline"
                      >
                        {item.deadlineLabel}
                      </span>
                    ) : null}
                    {item.contactEmail ? (
                      <span
                        className="mt-1 block break-all text-xs text-[#111]"
                        data-testid="pipeline-contact"
                      >
                        {item.contactEmail}
                      </span>
                    ) : null}
                  </>
                );
                return href && known.has(item.status) ? (
                  <Link
                    key={item.id}
                    href={href}
                    className={`mt-2 block rounded-md border border-[#e3e3e3] bg-white p-3 text-sm ${accent}`}
                  >
                    {body}
                  </Link>
                ) : (
                  <div
                    key={item.id}
                    className={`mt-2 rounded-md border border-[#e3e3e3] bg-white p-3 text-sm ${accent}`}
                  >
                    {body}
                  </div>
                );
              })
            )}
          </section>
        );
      })}
    </div>
  );
}
