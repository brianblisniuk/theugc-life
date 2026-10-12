import "server-only";

import { z } from "zod";

const schema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  // Optional until a real payment provider is connected.
  BILLING_WEBHOOK_SECRET: z.string().min(1).optional(),
});

export function serverEnv() {
  const parsed = schema.safeParse({
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    BILLING_WEBHOOK_SECRET: process.env.BILLING_WEBHOOK_SECRET,
  });

  if (!parsed.success) {
    throw new Error(`Invalid server environment: ${parsed.error.message}`);
  }

  return parsed.data;
}
