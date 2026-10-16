import Link from "next/link";

import { RegisterCrumbs } from "@/components/shell/breadcrumb-context";
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
      {crumbs && crumbs.length > 0 ? <RegisterCrumbs crumbs={crumbs} /> : null}
      {back ? (
        <p className="text-sm">
          <Link href={back.href} className="text-muted underline hover:text-text">
            ← Back to {back.label}
          </Link>
        </p>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-3xl font-extrabold tracking-tight text-text">{title}</h1>
        {actions}
      </div>
      {description ? <div className="max-w-prose text-sm text-muted">{description}</div> : null}
    </header>
  );
}
