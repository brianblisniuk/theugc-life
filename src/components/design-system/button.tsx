import Link from "next/link";
import type { ComponentProps } from "react";

type ButtonTone = "secondary" | "primary" | "ghost" | "dark";

const TONE_CLASS: Record<ButtonTone, string> = {
  secondary: "",
  primary: "is-primary",
  ghost: "is-ghost",
  dark: "is-dark",
};

function classes(tone: ButtonTone, small: boolean, block: boolean, className?: string) {
  return [
    "v12-btn",
    TONE_CLASS[tone],
    small ? "is-small" : "",
    block ? "is-block" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

type Common = {
  tone?: ButtonTone;
  small?: boolean;
  block?: boolean;
  children: React.ReactNode;
};

export function Button({
  tone = "secondary",
  small = false,
  block = false,
  className,
  children,
  ...rest
}: Common & ComponentProps<"button">) {
  return (
    <button className={classes(tone, small, block, className)} {...rest}>
      {children}
    </button>
  );
}

export function ButtonLink({
  tone = "secondary",
  small = false,
  block = false,
  className,
  children,
  ...rest
}: Common & ComponentProps<typeof Link>) {
  return (
    <Link className={classes(tone, small, block, className)} {...rest}>
      {children}
    </Link>
  );
}
