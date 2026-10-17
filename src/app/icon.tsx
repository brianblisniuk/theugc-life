import { ImageResponse } from "next/og";

import { BrandMark } from "@/lib/brand/mark-image";
import { ICON_SIZE } from "@/lib/brand/colors";

export const size = { width: ICON_SIZE, height: ICON_SIZE };
export const contentType = "image/png";

/** V12.2 mark. Next serves this as the app icon. `/favicon.ico` is the static file. */
export default function Icon() {
  return new ImageResponse(<BrandMark size={ICON_SIZE} />, { ...size });
}
