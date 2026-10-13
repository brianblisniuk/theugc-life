import Link from "next/link";

/** Wordmark. Sun is a highlight behind the suffix so it stays readable on paper (D048). */
export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="text-xl font-extrabold tracking-tight text-text">
      theugc<span className="bg-accent px-[3px] text-accent-contrast">.life</span>
    </Link>
  );
}
