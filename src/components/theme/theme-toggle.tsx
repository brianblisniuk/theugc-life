"use client";

import { useEffect, useState } from "react";

import { DEFAULT_THEME, THEME_STORAGE_KEY, parseTheme, themeLabel, type ThemeName } from "@/lib/ux02/theme";

export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeName>(DEFAULT_THEME);

  useEffect(() => {
    const current = parseTheme(document.documentElement.getAttribute("data-theme"));
    setTheme(current);
  }, []);

  function onToggle() {
    const next: ThemeName = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // The document attribute still switches for this view.
    }
    setTheme(next);
  }

  return (
    <button
      type="button"
      className="ux-btn ux-btn-quiet"
      data-theme-toggle
      aria-pressed={theme === "dark"}
      onClick={onToggle}
    >
      {themeLabel(theme)}
    </button>
  );
}
