import Link from "next/link";

import type { Crumb } from "@/lib/shell/navigation";

/**
 * One heading treatment for every authenticated surface (D081).
 * The last crumb is the current page and is not a link.
 */
export function PageHeader({
  title,
  description,
  crumbs,
  back,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  crumbs?: readonly Crumb[];
  back?: { href: string; label: string } | null;
  actions?: React.ReactNode;
}) {
  return (
    <header className="space-y-2">
      {crumbs && crumbs.length > 0 ? (
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-sm text-muted">
            {crumbs.map((crumb, index) => {
              const isLast = index === crumbs.length - 1;
              return (
                <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                  {index > 0 ? <span aria-hidden="true">/</span> : null}
                  {isLast || !crumb.href ? (
                    <span className="text-text" aria-current={isLast ? "page" : undefined}>
                      {crumb.label}
                    </span>
                  ) : (
                    <Link href={crumb.href} className="underline hover:text-text">
                      {crumb.label}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}
      {back ? (
        <p className="text-sm">
          <Link href={back.href} className="text-muted underline hover:text-text">
            ← Back to {back.label}
          </Link>
        </p>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-2xl font-semibold text-text">{title}</h1>
        {actions}
      </div>
      {description ? <div className="max-w-prose text-sm text-muted">{description}</div> : null}
    </header>
  );
}
