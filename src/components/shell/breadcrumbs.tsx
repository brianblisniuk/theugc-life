"use client";

import Link from "next/link";

import type { Crumb } from "@/lib/shell/navigation";

export function BreadcrumbTrail({ crumbs }: { crumbs: readonly Crumb[] }) {
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb">
      <ol className="v12-crumbs">
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <li key={`${crumb.label}-${index}`} className="v12-row" style={{ gap: 8 }}>
              {index > 0 ? (
                <span aria-hidden="true" className="v12-dotsep">
                  /
                </span>
              ) : null}
              {isLast || !crumb.href ? (
                <span aria-current={isLast ? "page" : undefined}>{crumb.label}</span>
              ) : (
                <Link href={crumb.href}>{crumb.label}</Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
