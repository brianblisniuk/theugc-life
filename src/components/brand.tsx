import Link from "next/link";

/** Minimal wordmark. Branding is a placeholder pending brand direction. */
export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="text-lg font-semibold tracking-tight text-text">
      theugc<span className="text-accent">.life</span>
    </Link>
  );
}
