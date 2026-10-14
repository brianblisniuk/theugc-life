/**
 * The send guard is a pure function of the environment and the recipient.
 *
 * Unrestricted sending is on only when GMAIL_SEND_ENV is exactly
 * `production`. NODE_ENV is not that switch: Next.js and Netlify set it
 * to production on staging and on deploy previews. Everywhere else the
 * allowlist is on. An unset list allows only hello@theugc.life. A set
 * list is enforced even when GMAIL_SEND_ENV=production.
 * GMAIL_SEND_DISABLED stops every send.
 * assessSendGuard does not read process.env, so a test can pass the env it means.
 */

export const STAGING_ALLOWLIST_RECIPIENT = "hello@theugc.life";

export interface SendGuardEnv {
  /** Recorded for tests. It does not open unrestricted sending. */
  nodeEnv?: string | null;
  /** GMAIL_SEND_ENV. Only the exact value `production` opens unrestricted sending. */
  sendEnv?: string | null;
  disabled?: string | null;
  allowlist?: string | null;
}

export type SendGuardDecision = { ok: true } | { ok: false; code: "kill_switch" | "allowlist" };

function disabledFlag(value: string | null | undefined): boolean {
  const flag = (value ?? "").trim().toLowerCase();
  return flag === "true" || flag === "1" || flag === "yes";
}

function allowlistAddresses(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

function unrestrictedSend(env: SendGuardEnv): boolean {
  return (env.sendEnv ?? "").trim() === "production";
}

export function assessSendGuard(env: SendGuardEnv, recipient: string): SendGuardDecision {
  if (disabledFlag(env.disabled)) return { ok: false, code: "kill_switch" };

  const configured = (env.allowlist ?? "").trim();
  if (unrestrictedSend(env) && configured.length === 0) return { ok: true };

  const allowed = allowlistAddresses(
    configured.length === 0 ? STAGING_ALLOWLIST_RECIPIENT : configured,
  );
  if (!allowed.includes(recipient.trim().toLowerCase())) {
    return { ok: false, code: "allowlist" };
  }
  return { ok: true };
}

/** The database clamps this. A blank or non-integer value stays at the default of 20. */
export function dailyCapFromEnv(raw: string | null | undefined): number {
  if (raw == null || raw.trim() === "") return 20;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return 20;
  return parsed;
}

export function sendGuardFromProcess(): SendGuardEnv & { dailyLimit: string | null } {
  return {
    nodeEnv: process.env.NODE_ENV ?? null,
    sendEnv: process.env.GMAIL_SEND_ENV ?? null,
    disabled: process.env.GMAIL_SEND_DISABLED ?? null,
    allowlist: process.env.GMAIL_SEND_ALLOWLIST ?? null,
    dailyLimit: process.env.GMAIL_SEND_DAILY_LIMIT ?? null,
  };
}
