import "server-only";

import { gmailHistoricalReadAdapter } from "@/lib/gmail/import/read-adapter.server";
import { createGmailIncrementalReadAdapter } from "@/lib/gmail/sync/read-adapter";

export const gmailIncrementalReadAdapter = createGmailIncrementalReadAdapter(
  gmailHistoricalReadAdapter,
);
