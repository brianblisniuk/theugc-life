import "server-only";

import { isUuid } from "@/lib/hotels/ids";
import { budgetWarning, userBudgetMicros, type AssistantTier } from "@/lib/ai/limits";
import { createClient } from "@/lib/supabase/server";

export interface OwnAiBudget {
  paused: boolean;
  sendsPaused: boolean;
  warning: boolean;
}

export interface MailSubjectChoice {
  id: string;
  subject: string;
}

export type AssistantChrome =
  | { status: "on"; priority: boolean; mail: MailSubjectChoice[] }
  | { status: "off"; reason: "free" }
  | { status: "off"; reason: "unknown" };

function flag(value: unknown): boolean {
  return value === true;
}

/** The caller's own pause and 80% warning. A failed read is not a warning. */
export async function loadOwnAiBudget(tier: AssistantTier): Promise<OwnAiBudget> {
  const empty = { paused: false, sendsPaused: false, warning: false };
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("read_own_ai_budget");
    if (error || !data || typeof data !== "object") return empty;
    const row = data as { result?: unknown; paused?: unknown; sends_paused?: unknown; spent_micros?: unknown };
    if (row.result !== "ok") return empty;
    const spent = typeof row.spent_micros === "number" ? row.spent_micros : 0;
    return {
      paused: row.paused === true,
      sendsPaused: row.sends_paused === true,
      warning: budgetWarning(spent, userBudgetMicros(tier)),
    };
  } catch {
    return empty;
  }
}

/** Plan flags for the pitch page. A failed read is unknown, not Free. */
export async function loadAssistantChrome(): Promise<AssistantChrome> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("own_plan_features");
    if (error || !data || typeof data !== "object") return { status: "off", reason: "unknown" };
    const record = data as { full_ai_email?: unknown; priority_ai?: unknown };
    if (!flag(record.full_ai_email)) return { status: "off", reason: "free" };
    const mail = await loadMailSubjects(supabase);
    return { status: "on", priority: flag(record.priority_ai), mail };
  } catch {
    return { status: "off", reason: "unknown" };
  }
}

async function loadMailSubjects(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<MailSubjectChoice[]> {
  const { data, error } = await supabase.rpc("list_own_mail_subjects", { p_limit: 8 });
  if (error || !Array.isArray(data)) return [];
  const choices: MailSubjectChoice[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const record = row as { message_id?: unknown; subject?: unknown };
    const id = typeof record.message_id === "string" ? record.message_id : "";
    if (!isUuid(id)) continue;
    const subject = typeof record.subject === "string" ? record.subject.trim() : "";
    choices.push({
      id,
      subject: subject.length > 0 ? subject.slice(0, 80) : "Message",
    });
  }
  return choices;
}
