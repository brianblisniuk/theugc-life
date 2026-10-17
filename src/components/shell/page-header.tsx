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
  void crumbs;
  return (
    <header className="v12-pagehead">
      <div className="v12-pagehead-copy">
        {back ? (
          <p className="text-sm">
            <Link href={back.href} className="text-muted underline hover:text-text">
              ← Back to {back.label}
            </Link>
          </p>
        ) : null}
        <h1>{title}</h1>
        {description ? (
          <div className="v12-pagehead-lede max-w-prose text-sm text-muted">{description}</div>
        ) : null}
      </div>
      {actions ? <div className="v12-head-actions">{actions}</div> : null}
    </header>
  );
}
