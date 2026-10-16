import Link from "next/link";

import { pipelineSurfaces, type PipelineSurface } from "@/lib/shell/navigation";

/** Pipeline, Inbox, and Collaborations share one list and one shell (D081). */
export function PipelineSurfaceNav({ surface }: { surface: PipelineSurface }) {
  return (
    <nav
      aria-label="Pipeline sections"
      className="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:px-0"
    >
      {pipelineSurfaces().map((item) => {
        const current = item.id === surface;
        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={current ? "page" : undefined}
            className={
              "inline-flex min-h-11 shrink-0 items-center rounded-md border px-3 text-sm font-semibold " +
              (current ? "border-accent bg-accent text-accent-contrast" : "border-border text-text")
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
