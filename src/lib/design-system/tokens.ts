/**
 * V12.1 color tokens (D182). Swatches match styles.css. Text inks are the
 * colors the components actually paint, including the one-step darker amber
 * used so small pill type clears WCAG AA on its tint.
 */
export const V12_TOKENS = {
  ink: "#1b281f",
  muted: "#637366",
  bg: "#f6f8f4",
  paper: "#ffffff",
  stroke: "#dfe8dd",
  nav: "#182920",
  lime: "#dfff4f",
  limeInk: "#1d3018",
  limeTint: "#f0f8d6",
  mint: "#eaf4e5",
  green: "#38794a",
  greenInk: "#337345",
  amber: "#9e722d",
  amberBg: "#fcf3e3",
  amberInk: "#926621",
  blue: "#4b7889",
  blueBg: "#eaf3f7",
  blueInk: "#457283",
  red: "#ad5b4e",
  redBg: "#faeeeb",
  redInk: "#a75548",
  grayInk: "#4d5a50",
  grayBg: "#f0f2f0",
  sidebarText: "#c0cfc3",
  sidebarSection: "#91a598",
  activeNavInk: "#162519",
  navActive: "#dfff4f",
} as const;

/** Pairs that must clear WCAG AA for normal text (4.5:1). */
export const V12_TEXT_PAIRS = [
  { name: "ink on canvas", fg: V12_TOKENS.ink, bg: V12_TOKENS.bg },
  { name: "ink on paper", fg: V12_TOKENS.ink, bg: V12_TOKENS.paper },
  { name: "muted on canvas", fg: V12_TOKENS.muted, bg: V12_TOKENS.bg },
  { name: "muted on paper", fg: V12_TOKENS.muted, bg: V12_TOKENS.paper },
  { name: "lime ink on lime", fg: V12_TOKENS.limeInk, bg: V12_TOKENS.lime },
  { name: "active nav ink on lime", fg: V12_TOKENS.activeNavInk, bg: V12_TOKENS.navActive },
  { name: "sidebar link on nav", fg: V12_TOKENS.sidebarText, bg: V12_TOKENS.nav },
  { name: "sidebar section on nav", fg: V12_TOKENS.sidebarSection, bg: V12_TOKENS.nav },
  { name: "green ink on mint", fg: V12_TOKENS.greenInk, bg: V12_TOKENS.mint },
  { name: "amber ink on amber tint", fg: V12_TOKENS.amberInk, bg: V12_TOKENS.amberBg },
  { name: "blue ink on blue tint", fg: V12_TOKENS.blueInk, bg: V12_TOKENS.blueBg },
  { name: "red ink on red tint", fg: V12_TOKENS.redInk, bg: V12_TOKENS.redBg },
  { name: "gray ink on gray tint", fg: V12_TOKENS.grayInk, bg: V12_TOKENS.grayBg },
] as const;

/** Lime as text on the light canvas fails. Components must not do this. */
export const V12_LIME_ON_CANVAS = { fg: V12_TOKENS.lime, bg: V12_TOKENS.bg } as const;
export const V12_LIME_ON_PAPER = { fg: V12_TOKENS.lime, bg: V12_TOKENS.paper } as const;
