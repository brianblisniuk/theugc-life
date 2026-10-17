/**
 * Shared signup confirmation copy and the resend cooldown.
 * The address in the panel is the address the signup action accepted.
 */

export const CONFIRM_SENTENCE = "Check your email to confirm your account.";
export const RESEND_SUCCESS = "We sent another confirmation email.";
export const RESEND_ERROR = "Could not resend the confirmation email. Try again.";
export const RESEND_COOLDOWN_MS = 60_000;

export function signupEmailRedirectTo(siteUrl: string): string {
  return `${siteUrl}/auth/callback?next=/onboarding`;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function signupResendRequest(
  email: string,
  siteUrl: string,
): {
  type: "signup";
  email: string;
  options: { emailRedirectTo: string };
} | null {
  if (/[\u0000-\u001F\u007F]/.test(email)) return null;
  const trimmed = email.trim();
  if (!EMAIL.test(trimmed) || trimmed.length > 320) return null;
  return {
    type: "signup",
    email: trimmed,
    options: { emailRedirectTo: signupEmailRedirectTo(siteUrl) },
  };
}

/** Whole seconds left in the cooldown. Zero once `now` reaches `until`. */
export function cooldownRemaining(nowMs: number, untilMs: number): number {
  const left = untilMs - nowMs;
  if (left <= 0) return 0;
  return Math.ceil(left / 1000);
}

export function resendDecision(input: {
  nowMs: number;
  untilMs: number;
  sending: boolean;
}): "wait" | "send" {
  if (input.sending) return "wait";
  if (cooldownRemaining(input.nowMs, input.untilMs) > 0) return "wait";
  return "send";
}
