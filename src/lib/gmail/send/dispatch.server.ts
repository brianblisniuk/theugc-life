import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getFreshGmailAccessToken } from "@/lib/gmail/connection.server";
import { googleOAuthAdapter } from "@/lib/gmail/google.server";
import { sendGuardFromProcess } from "@/lib/gmail/send/guard";
import type { SendDeps } from "@/lib/gmail/send/service.server";

export function productionSendDeps(): SendDeps {
  const db = createAdminClient();
  return {
    db,
    google: googleOAuthAdapter,
    env: sendGuardFromProcess(),
    getAccessToken: (mailAccountId) =>
      getFreshGmailAccessToken({ mailAccountId }, { db, google: googleOAuthAdapter }),
  };
}
