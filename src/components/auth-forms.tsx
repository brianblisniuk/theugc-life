"use client";

import Link from "next/link";
import { useActionState } from "react";

import {
  completeOnboarding,
  requestPasswordReset,
  signIn,
  signUp,
  updatePassword,
  type AuthActionState,
} from "@/lib/auth/actions";

const initial: AuthActionState = {};

const fieldClass =
  "w-full rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text outline-none focus-visible:border-accent";
const labelClass = "block text-sm font-medium text-text";
const buttonClass =
  "w-full rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast disabled:opacity-60";
const errorClass = "text-sm text-danger";
const messageClass = "text-sm text-success";

function FormError({ state }: { state: AuthActionState }) {
  if (state.error) {
    return (
      <p className={errorClass} role="alert">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return <p className={messageClass}>{state.message}</p>;
  }
  return null;
}

export function LoginForm({ redirectTo }: { redirectTo?: string }) {
  const [state, action, pending] = useActionState(signIn, initial);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="redirect" value={redirectTo ?? "/app"} />
      <div className="space-y-1">
        <label className={labelClass} htmlFor="email">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className={fieldClass}
        />
      </div>
      <div className="space-y-1">
        <label className={labelClass} htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={fieldClass}
        />
      </div>
      <FormError state={state} />
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
      <p className="text-sm text-muted">
        <Link href="/forgot-password" className="text-accent">
          Forgot your password?
        </Link>
      </p>
    </form>
  );
}

export function SignupForm({ redirectTo }: { redirectTo?: string }) {
  const [state, action, pending] = useActionState(signUp, initial);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="redirect" value={redirectTo ?? "/onboarding"} />
      <div className="space-y-1">
        <label className={labelClass} htmlFor="email">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className={fieldClass}
        />
      </div>
      <div className="space-y-1">
        <label className={labelClass} htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          className={fieldClass}
        />
        <p className="text-xs text-muted">At least 8 characters.</p>
      </div>
      <FormError state={state} />
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(requestPasswordReset, initial);
  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1">
        <label className={labelClass} htmlFor="email">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className={fieldClass}
        />
      </div>
      <FormError state={state} />
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Sending…" : "Send reset link"}
      </button>
    </form>
  );
}

export function ResetPasswordForm() {
  const [state, action, pending] = useActionState(updatePassword, initial);
  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1">
        <label className={labelClass} htmlFor="password">
          New password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          className={fieldClass}
        />
      </div>
      <FormError state={state} />
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Updating…" : "Update password"}
      </button>
    </form>
  );
}

export function OnboardingForm() {
  const [state, action, pending] = useActionState(completeOnboarding, initial);
  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1">
        <label className={labelClass} htmlFor="display_name">
          Display name
        </label>
        <input id="display_name" name="display_name" type="text" required className={fieldClass} />
      </div>
      <div className="space-y-1">
        <label className={labelClass} htmlFor="username">
          Username
        </label>
        <input id="username" name="username" type="text" required className={fieldClass} />
        <p className="text-xs text-muted">Letters, numbers, or underscores.</p>
      </div>
      <FormError state={state} />
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Saving…" : "Continue"}
      </button>
    </form>
  );
}
