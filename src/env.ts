import { z } from "zod";

/**
 * CLIENT-safe environment validation.
 *
 * Only `NEXT_PUBLIC_*` values live here. This module is import-safe from client
 * components, so it must never reference server secrets — server validation
 * lives in `src/lib/env.server.ts` (guarded by `server-only`). Keeping the two
 * apart also ensures the server schema/keys are never bundled for the browser.
 *
 * Validation runs lazily (on first access) so tooling that imports modules
 * without a full environment does not crash, while runtime access fails fast
 * with a readable error.
 */

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_SITE_URL: z.string().url(),
  // Analytics is optional: absent key => analytics no-ops (see lib/analytics).
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().url().optional(),
});

export type ClientEnv = z.infer<typeof clientSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

let _clientEnv: ClientEnv | undefined;

/** Client-safe environment. Only `NEXT_PUBLIC_*` values. Safe to import anywhere. */
export function getClientEnv(): ClientEnv {
  if (_clientEnv) return _clientEnv;
  const parsed = clientSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  });
  if (!parsed.success) {
    throw new Error(`Invalid client environment variables:\n${formatIssues(parsed.error)}`);
  }
  _clientEnv = parsed.data;
  return _clientEnv;
}
