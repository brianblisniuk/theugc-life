import { assertCollaborationClassifier } from "@/lib/gmail/collaboration/classifier";

interface RpcClient {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

/**
 * Run the heuristic detector for one stored thread.
 * A classifier other than `heuristic` throws before the database is called.
 */
export async function refreshGmailCollaborationSuggestions(
  db: RpcClient,
  input: { userId: string; mailAccountId: string; normalizedThreadId: string },
): Promise<{ result: string }> {
  assertCollaborationClassifier();
  const { data, error } = await db.rpc("refresh_gmail_collaboration_suggestions", {
    p_user_id: input.userId,
    p_mail_account_id: input.mailAccountId,
    p_normalized_thread_id: input.normalizedThreadId,
  });
  if (error) {
    throw new Error(`refresh_gmail_collaboration_suggestions failed: ${error.message}`);
  }
  const result = (data as { result?: unknown } | null)?.result;
  return { result: typeof result === "string" ? result : "error" };
}
