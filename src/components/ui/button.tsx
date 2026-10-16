import Link from "next/link";

type Variant = "primary" | "secondary" | "dark" | "ghost";

function classes(variant: Variant, size: "default" | "small", block: boolean): string {
  return [
    "v12-btn",
    variant === "primary" ? "v12-btn-primary" : "",
    variant === "dark" ? "v12-btn-dark" : "",
    variant === "ghost" ? "v12-btn-ghost" : "",
    size === "small" ? "v12-btn-small" : "",
    block ? "v12-btn-block" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function Button({
  variant = "secondary",
  size = "default",
  block = false,
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "default" | "small";
  block?: boolean;
}) {
  return <button type={type} className={classes(variant, size, block)} {...props} />;
}

export function ButtonLink({
  href,
  variant = "secondary",
  size = "default",
  block = false,
  children,
}: {
  href: string;
  variant?: Variant;
  size?: "default" | "small";
  block?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className={classes(variant, size, block)}>
      {children}
    </Link>
  );
}
