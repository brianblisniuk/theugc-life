/**
 * Validates .grok/autopilot-state.json against its schema.
 * Live GitHub outranks this file; this only guarantees it is well-formed and
 * internally consistent. Run: `npm run autopilot:validate`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

const sha = z.string().regex(/^[0-9a-f]{40}$/, "must be a full 40-char lowercase SHA");

export const STATES = [
  "IDLE",
  "PLANNING",
  "BUILDING",
  "AUDITING",
  "CORRECTING",
  "AWAITING_CI",
  "AWAITING_MERGE_DECISION",
  "HUMAN_FRONTIER",
  "BLOCKED",
] as const;

export const HUMAN_FRONTIERS = [
  "PRODUCT DECISION REQUIRED",
  "CREDENTIAL REQUIRED",
  "EXTERNAL ACTION APPROVAL REQUIRED",
  "MERGE DECISION REQUIRED",
  "TECHNICALLY BLOCKED",
  "AUTOPILOT FRONTIER COMPLETE",
] as const;

export const autopilotStateSchema = z
  .object({
    $comment: z.string().optional(),
    schema_version: z.literal(1),
    as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    state: z.enum(STATES),
    last_recorded_main: sha,
    active_block: z.string().min(1).nullable(),
    branch: z.string().min(1).nullable(),
    pr: z.number().int().positive().nullable(),
    expected_head: sha.nullable(),
    pending_jobs: z.array(z.string().min(1)),
    unresolved_findings: z.array(
      z
        .object({
          id: z.string().min(1),
          severity: z.enum(["BLOCKING", "NON-BLOCKING"]),
          summary: z.string().min(1),
          ref: z.string().min(1),
        })
        .strict(),
    ),
    ci_status: z
      .object({ ref: sha, verify: z.enum(["success", "failure", "pending", "unknown"]) })
      .strict(),
    required_human_action: z.string().nullable(),
    next_dependency: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (
      s.required_human_action !== null &&
      !HUMAN_FRONTIERS.some((f) => s.required_human_action!.startsWith(f))
    ) {
      issue("required_human_action must start with one of the six human-frontier labels");
    }
    if (
      (s.state === "HUMAN_FRONTIER" || s.state === "AWAITING_MERGE_DECISION") &&
      s.required_human_action === null
    ) {
      issue(`state ${s.state} requires required_human_action`);
    }
    if (s.state === "AWAITING_MERGE_DECISION" && (s.pr === null || s.expected_head === null)) {
      issue("AWAITING_MERGE_DECISION requires pr and expected_head");
    }
    if (s.expected_head !== null && s.pr === null) issue("expected_head requires pr");
    if (
      s.unresolved_findings.some((f) => f.severity === "BLOCKING") &&
      s.state === "AWAITING_MERGE_DECISION"
    ) {
      issue("cannot await a merge decision with BLOCKING findings unresolved");
    }
  });

export type AutopilotState = z.infer<typeof autopilotStateSchema>;

export function validateAutopilotState(json: unknown) {
  return autopilotStateSchema.safeParse(json);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]).endsWith("validate-autopilot-state.ts");
if (isMain) {
  const file = path.resolve(process.cwd(), ".grok/autopilot-state.json");
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`autopilot-state: cannot read/parse ${file}: ${(e as Error).message}`);
    process.exit(1);
  }
  const res = validateAutopilotState(json);
  if (!res.success) {
    for (const i of res.error.issues)
      console.error(`autopilot-state: ${i.path.join(".") || "(root)"}: ${i.message}`);
    process.exit(1);
  }
  console.log(`autopilot-state: OK (state=${res.data.state})`);
}
