import { MARK_DARK, MARK_LIME } from "@/lib/brand/colors";

/** Square midnight field with the lime dot. Satori paints this for app icons. */
export function BrandMark({ size }: { size: number }) {
  const dot = Math.max(4, Math.round(size * 0.44));
  return (
    <div
      style={{
        width: size,
        height: size,
        background: MARK_DARK,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: dot,
          height: dot,
          borderRadius: "50%",
          background: MARK_LIME,
        }}
      />
    </div>
  );
}
