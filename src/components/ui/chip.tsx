export function Chip({
  pressed = false,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { pressed?: boolean }) {
  return (
    <button type="button" className="v12-chip" aria-pressed={pressed} {...props}>
      {children}
    </button>
  );
}
