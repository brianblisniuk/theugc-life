export function Chip({
  pressed = false,
  children,
  ...rest
}: {
  pressed?: boolean;
  children: React.ReactNode;
} & Omit<React.ComponentProps<"button">, "children">) {
  return (
    <button type="button" className="v12-chip" aria-pressed={pressed} {...rest}>
      {children}
    </button>
  );
}
