/**
 * V12.2 icon catalog. Paths are the drawings in docs/design/v12.2/*.html.
 * Shell and action buttons import this file. Do not redraw them by hand.
 * `contract` is the reference drawing only. It is not a navigation item.
 */
import type { SVGProps } from "react";

export const V12_ICON_NAMES = [
  "home",
  "discover",
  "trips",
  "outreach",
  "pipeline",
  "pitch",
  "inbox",
  "collaborations",
  "profile",
  "plans",
  "billing",
  "start",
  "guide",
  "account",
  "arrow",
  "chevron",
  "plus",
  "bookmark",
  "save",
  "copy",
  "lock",
  "list",
  "clock",
  "contract",
] as const;

export type V12IconName = (typeof V12_ICON_NAMES)[number];

type IconNode =
  | { t: "path"; d: string }
  | { t: "circle"; cx: string; cy: string; r: string }
  | { t: "rect"; x: string; y: string; width: string; height: string; rx?: string };

export const V12_ICONS: Record<V12IconName, readonly IconNode[]> = {
  home: [{ t: "path", d: "m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4z" }],
  discover: [
    { t: "circle", cx: "12", cy: "12", r: "9" },
    { t: "path", d: "m16 8-2.5 5.5L8 16l2.5-5.5z" },
  ],
  trips: [{ t: "path", d: "M22 2 9 15m13-13-7 20-4-9-9-4z" }],
  outreach: [{ t: "path", d: "m22 2-7 20-4-9-9-4zM22 2 11 13" }],
  pipeline: [
    { t: "rect", x: "3", y: "3", width: "7", height: "18", rx: "1" },
    { t: "rect", x: "14", y: "3", width: "7", height: "18", rx: "1" },
  ],
  pitch: [{ t: "path", d: "M12 20h9M4 16l-1 5 5-1L20 8l-4-4z" }],
  inbox: [
    { t: "rect", x: "3", y: "4", width: "18", height: "16", rx: "2" },
    { t: "path", d: "M3 14h5l2 3h4l2-3h5" },
  ],
  collaborations: [
    { t: "rect", x: "3", y: "7", width: "18", height: "14", rx: "2" },
    { t: "path", d: "M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 12h18" },
  ],
  profile: [
    { t: "circle", cx: "12", cy: "8", r: "4" },
    { t: "path", d: "M4 21v-2a8 8 0 0 1 16 0v2" },
  ],
  plans: [
    { t: "rect", x: "2", y: "4", width: "20", height: "16", rx: "3" },
    { t: "path", d: "M2 10h20M6 15h4" },
  ],
  billing: [
    { t: "rect", x: "3", y: "6", width: "18", height: "14", rx: "2" },
    { t: "path", d: "M15 12h6M3 9V5h15" },
  ],
  start: [{ t: "path", d: "m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z" }],
  guide: [
    { t: "circle", cx: "12", cy: "12", r: "3" },
    {
      t: "path",
      d: "M12 2v3M12 19v3M2 12h3M19 12h3M4.8 4.8l2 2M17.2 17.2l2 2M19.2 4.8l-2 2M6.8 17.2l-2 2",
    },
  ],
  account: [
    { t: "circle", cx: "12", cy: "12", r: "8" },
    { t: "path", d: "M12 8v4M12 16h.01" },
  ],
  arrow: [{ t: "path", d: "M4 12h16m-6-6 6 6-6 6" }],
  chevron: [{ t: "path", d: "m9 18 6-6-6-6" }],
  plus: [{ t: "path", d: "M12 4v16M4 12h16" }],
  bookmark: [{ t: "path", d: "M6 3h12v18l-6-4-6 4z" }],
  save: [
    { t: "rect", x: "4", y: "2", width: "16", height: "20", rx: "2" },
    { t: "path", d: "M8 7h8M8 12h8M8 17h5" },
  ],
  copy: [
    {
      t: "path",
      d: "M10 13a5 5 0 0 0 7 .5l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.5l-3 3a5 5 0 0 0 7 7l2-2",
    },
  ],
  lock: [
    { t: "rect", x: "4", y: "10", width: "16", height: "12", rx: "2" },
    { t: "path", d: "M8 10V7a4 4 0 0 1 8 0v3" },
  ],
  list: [{ t: "path", d: "M4 7h16M4 12h16M4 17h16" }],
  clock: [
    { t: "circle", cx: "12", cy: "12", r: "9" },
    { t: "path", d: "M12 7v5l4 2" },
  ],
  contract: [{ t: "path", d: "M6 2h9l5 5v14H6zM14 2v6h6M9 13h8M9 17h8" }],
};

export function V12Icon({
  name,
  size,
  ...props
}: { name: V12IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  const nodes = V12_ICONS[name];
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {nodes.map((node, index) => {
        if (node.t === "path") return <path key={index} d={node.d} />;
        if (node.t === "circle") return <circle key={index} cx={node.cx} cy={node.cy} r={node.r} />;
        return (
          <rect
            key={index}
            x={node.x}
            y={node.y}
            width={node.width}
            height={node.height}
            rx={node.rx}
          />
        );
      })}
    </svg>
  );
}
