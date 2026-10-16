import Link from "next/link";

export function Chip({
  pressed = false,
  href,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { pressed?: boolean; href?: string }) {
  if (href) {
    return (
      <Link href={href} className="v12-chip" aria-current={pressed ? "page" : undefined}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" className="v12-chip" aria-pressed={pressed} {...props}>
      {children}
    </button>
  );
}
