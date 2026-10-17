import { ImageResponse } from "next/og";

import { BrandMark } from "@/lib/brand/mark-image";
import { APPLE_ICON_SIZE } from "@/lib/brand/colors";

export const size = { width: APPLE_ICON_SIZE, height: APPLE_ICON_SIZE };
export const contentType = "image/png";

/** 180px apple touch icon. Same lime-on-midnight mark as the favicon. */
export default function AppleIcon() {
  return new ImageResponse(<BrandMark size={APPLE_ICON_SIZE} />, { ...size });
}
