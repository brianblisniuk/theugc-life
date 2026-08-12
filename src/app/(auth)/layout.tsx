import { Brand } from "@/components/brand";

/** Auth shell: centered card for sign-in / sign-up / password flows. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Brand />
        </div>
        <div className="rounded-[var(--radius-app)] border border-border bg-surface p-6">
          {children}
        </div>
      </div>
    </div>
  );
}
