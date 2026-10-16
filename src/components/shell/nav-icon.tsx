import type { ShellIcon } from "@/lib/shell/navigation";

const PATHS: Record<ShellIcon | "menu", string> = {
  home: "M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4z",
  discover: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm4 5-2.5 5.5L8 16l2.5-5.5z",
  trips: "M22 2 9 15M22 2l-7 20-4-9-9-4z",
  pipeline: "M3 3h7v18H3zM14 3h7v18h-7z",
  inbox: "M3 4h18v16H3zM3 14h5l2 3h4l2-3h5",
  collaborations: "M3 7h18v14H3zM9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 12h18",
  profile: "M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM4 21v-2a8 8 0 0 1 16 0v2",
  account: "M2 4h20v16H2zM2 10h20M6 15h4",
  billing: "M3 6h18v14H3zM15 12h6M3 9V5h15",
  start: "m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z",
  menu: "M4 7h16M4 12h16M4 17h16",
};

export function NavIcon({ name }: { name: ShellIcon | "menu" }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
