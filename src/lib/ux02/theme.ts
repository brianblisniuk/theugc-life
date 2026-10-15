/**
 * UX02 theme. Dark is the default. Light uses the same token names.
 * The accent is a fill. It is never a text or icon color.
 */

export const THEME_STORAGE_KEY = "ugc-theme";

export const THEMES = ["dark", "light"] as const;

export type ThemeName = (typeof THEMES)[number];

export const DEFAULT_THEME: ThemeName = "dark";

/** Anything other than an explicit light choice stays dark. */
export function parseTheme(value: string | null | undefined): ThemeName {
  return value === "light" ? "light" : DEFAULT_THEME;
}

export function themeLabel(theme: ThemeName): string {
  return theme === "light" ? "Theme: Light" : "Theme: Dark";
}

/**
 * Runs before paint. Only `light` and `dark` are written onto the document.
 * A thrown storage read leaves the server default, which is dark.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;
