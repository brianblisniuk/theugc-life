"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

import type { Crumb } from "@/lib/shell/navigation";

interface BreadcrumbContextValue {
  crumbs: readonly Crumb[] | null;
  setCrumbs: (crumbs: readonly Crumb[] | null) => void;
}

const BreadcrumbContext = createContext<BreadcrumbContextValue | null>(null);

export function BreadcrumbProvider({ children }: { children: React.ReactNode }) {
  const [crumbs, setCrumbs] = useState<readonly Crumb[] | null>(null);
  const value = useMemo(() => ({ crumbs, setCrumbs }), [crumbs]);
  return <BreadcrumbContext.Provider value={value}>{children}</BreadcrumbContext.Provider>;
}

export function useBreadcrumbs(): readonly Crumb[] | null {
  return useContext(BreadcrumbContext)?.crumbs ?? null;
}

/** Pages that already know their trail register it for the shell. */
export function RegisterCrumbs({ crumbs }: { crumbs: readonly Crumb[] }) {
  const setCrumbs = useContext(BreadcrumbContext)?.setCrumbs;
  const key = JSON.stringify(crumbs);
  const crumbsRef = useRef(crumbs);
  crumbsRef.current = crumbs;
  useEffect(() => {
    if (!setCrumbs) return;
    setCrumbs(crumbsRef.current);
    return () => setCrumbs(null);
  }, [key, setCrumbs]);
  return null;
}
