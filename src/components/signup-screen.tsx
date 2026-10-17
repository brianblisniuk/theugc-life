"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { SignupForm } from "@/components/auth-forms";
import { resendSignupConfirmation } from "@/lib/auth/actions";
import {
  CONFIRM_SENTENCE,
  RESEND_COOLDOWN_MS,
  RESEND_ERROR,
  RESEND_SUCCESS,
  cooldownRemaining,
  resendDecision,
} from "@/lib/auth/signup-confirm";

const buttonClass =
  "w-full rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast disabled:opacity-60";

function CheckEmailPanel({ email, onUseDifferent }: { email: string; onUseDifferent: () => void }) {
  const [until, setUntil] = useState(() => Date.now() + RESEND_COOLDOWN_MS);
  const [now, setNow] = useState(() => Date.now());
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(
    null,
  );
  const remaining = cooldownRemaining(now, until);

  useEffect(() => {
    if (cooldownRemaining(Date.now(), until) <= 0) return;
    const id = window.setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (cooldownRemaining(next, until) <= 0) window.clearInterval(id);
    }, 250);
    return () => window.clearInterval(id);
  }, [until]);

  async function resend() {
    if (resendDecision({ nowMs: Date.now(), untilMs: until, sending }) !== "send") return;
    setSending(true);
    setFeedback(null);
    try {
      const result = await resendSignupConfirmation(email);
      setFeedback({
        kind: "error" in result ? "error" : "success",
        text: "error" in result ? result.error : RESEND_SUCCESS,
      });
    } catch {
      setFeedback({ kind: "error", text: RESEND_ERROR });
    } finally {
      setSending(false);
      const sentAt = Date.now();
      setUntil(sentAt + RESEND_COOLDOWN_MS);
      setNow(sentAt);
    }
  }

  const label = sending
    ? "Sending…"
    : remaining > 0
      ? `Resend email (${remaining}s)`
      : "Resend email";

  return (
    <section className="space-y-4" aria-labelledby="check-email-title">
      <header className="v12-pagehead">
        <div>
          <p className="text-xs font-bold tracking-[0.14em] text-accent">CONFIRMATION</p>
          <h1 id="check-email-title" className="mt-1">
            Check your email
          </h1>
          <p>
            {CONFIRM_SENTENCE} We sent the link to{" "}
            <strong className="font-semibold text-text">{email}</strong>.
          </p>
        </div>
      </header>
      <button
        type="button"
        className={buttonClass}
        disabled={sending || remaining > 0}
        onClick={() => void resend()}
      >
        {label}
      </button>
      {feedback ? (
        <p
          className={feedback.kind === "error" ? "text-sm text-danger" : "text-sm text-success"}
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.text}
        </p>
      ) : null}
      <button type="button" className="text-sm font-semibold text-accent" onClick={onUseDifferent}>
        Use a different email
      </button>
    </section>
  );
}

/** Signup, then the confirmation panel in place of the form. */
export function SignupScreen({ redirectTo }: { redirectTo?: string }) {
  const [confirmedEmail, setConfirmedEmail] = useState<string | null>(null);
  if (confirmedEmail) {
    return (
      <CheckEmailPanel email={confirmedEmail} onUseDifferent={() => setConfirmedEmail(null)} />
    );
  }
  return (
    <div className="space-y-5">
      <header className="v12-pagehead">
        <div>
          <h1>Create your account</h1>
          <p>Start free in under a minute.</p>
        </div>
      </header>
      <SignupForm redirectTo={redirectTo} onConfirmed={setConfirmedEmail} />
      <p className="text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="text-accent">
          Sign in
        </Link>
      </p>
    </div>
  );
}
