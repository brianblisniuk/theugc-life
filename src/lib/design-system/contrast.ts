/** WCAG 2.x relative luminance and contrast ratio. */

function channel(hexPair: string): number {
  const value = parseInt(hexPair, 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const normalized = hex.trim().replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new Error(`Expected a 6-digit hex color, received ${hex}`);
  }
  const r = channel(normalized.slice(0, 2));
  const g = channel(normalized.slice(2, 4));
  const b = channel(normalized.slice(4, 6));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

export const WCAG_AA_NORMAL = 4.5;
