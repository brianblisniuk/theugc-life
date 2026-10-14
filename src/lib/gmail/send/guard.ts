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

export interface PlanSendCaps {
  pro: number;
  max: number;
}

/**
 * Soft daily caps (D168). Blank or non-integer values stay at Pro 120 and Max 300.
 * The database clamps a higher Pro value to 240 and a higher Max value to 600.
 */
export function planCapsFromEnv(env: {
  proDailyCap?: string | null;
  maxDailyCap?: string | null;
} | null | undefined): PlanSendCaps {
  return {
    pro: rawCap(env?.proDailyCap, 120),
    max: rawCap(env?.maxDailyCap, 300),
  };
}

function rawCap(raw: string | null | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return parsed;
}

/** Inclusive random gap of 180 to 300 seconds. */
export function spacingSeconds(random: () => number = Math.random): number {
  const roll = random();
  const unit = Number.isFinite(roll) ? Math.min(1, Math.max(0, roll)) : 0;
  return 180 + Math.floor(unit * 121);
}

export function sendGuardFromProcess(): SendGuardEnv & {
  proDailyCap: string | null;
  maxDailyCap: string | null;
} {
  return {
    nodeEnv: process.env.NODE_ENV ?? null,
    sendEnv: process.env.GMAIL_SEND_ENV ?? null,
    disabled: process.env.GMAIL_SEND_DISABLED ?? null,
    allowlist: process.env.GMAIL_SEND_ALLOWLIST ?? null,
    proDailyCap: process.env.GMAIL_SEND_PRO_DAILY_CAP ?? null,
    maxDailyCap: process.env.GMAIL_SEND_MAX_DAILY_CAP ?? null,
  };
}
