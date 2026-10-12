import Link from "next/link";

/** Wordmark. Sun is a highlight behind the suffix so it stays readable on paper (D048). */
export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="text-lg font-semibold tracking-tight text-text">
      theugc<span className="bg-accent px-0.5 text-accent-contrast">.life</span>
    </Link>
  );
}
