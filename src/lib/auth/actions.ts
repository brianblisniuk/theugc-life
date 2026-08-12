"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { getClientEnv } from "@/env";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

export interface AuthActionState {
  error?: string;
  message?: string;
}

const credentials = z.object({
  email: z.string().email("Enter a valid email."),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

/** Only allow same-origin relative redirect targets (avoid open redirects). */
function safeRedirect(target: FormDataEntryValue | null): string {
  const value = typeof target === "string" ? target : "";
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  return "/app";
}

export async function signIn(_prev: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const parsed = credentials.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    // Generic message: do not reveal whether the email exists.
    return { error: "Invalid email or password." };
  }
  redirect(safeRedirect(formData.get("redirect")));
}

export async function signUp(_prev: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const parsed = credentials.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const env = getClientEnv();
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    ...parsed.data,
    options: {
      emailRedirectTo: `${env.NEXT_PUBLIC_SITE_URL}/auth/callback?next=/onboarding`,
    },
  });

  if (error) {
    return { error: error.message };
  }

  // With email confirmations enabled the user must confirm first; otherwise a
  // session is created immediately. The public.users + creator_profiles rows are
  // provisioned by the handle_new_user DB trigger (role forced to 'creator').
  if (data.session) {
    redirect("/onboarding");
  }
  return { message: "Check your email to confirm your account." };
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}

export async function requestPasswordReset(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = z.string().email().safeParse(formData.get("email"));
  if (!email.success) {
    return { error: "Enter a valid email." };
  }

  const env = getClientEnv();
  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email.data, {
    redirectTo: `${env.NEXT_PUBLIC_SITE_URL}/auth/callback?next=/reset-password`,
  });
  if (error) {
    logger.warn("password reset request failed", { code: error.status });
  }
  // Always report success to avoid account enumeration.
  return { message: "If that email exists, a reset link is on its way." };
}

export async function updatePassword(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const password = z.string().min(8).safeParse(formData.get("password"));
  if (!password.success) {
    return { error: "Password must be at least 8 characters." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: "Reset link is invalid or expired. Request a new one." };
  }

  const { error } = await supabase.auth.updateUser({ password: password.data });
  if (error) {
    return { error: error.message };
  }
  redirect("/app");
}

const onboarding = z.object({
  display_name: z.string().min(1, "Add a display name.").max(80),
  username: z
    .string()
    .min(3, "Username must be at least 3 characters.")
    .max(30)
    .regex(/^[a-z0-9_]+$/i, "Use letters, numbers, or underscores only."),
});

export async function completeOnboarding(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = onboarding.safeParse({
    display_name: formData.get("display_name"),
    username: formData.get("username"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  // Ownership is enforced by RLS: the update only matches the caller's own
  // creator_profiles row (user_id = auth.uid()).
  const { error } = await supabase
    .from("creator_profiles")
    .update({
      display_name: parsed.data.display_name,
      username: parsed.data.username,
    })
    .eq("user_id", user.id);

  if (error) {
    if (error.code === "23505") {
      return { error: "That username is taken. Try another." };
    }
    return { error: "Could not save your profile. Try again." };
  }
  redirect("/app/discover");
}
