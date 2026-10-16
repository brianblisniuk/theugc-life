"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { getClientEnv } from "@/env";
import { safeRedirect } from "@/lib/auth/safe-redirect";
import { bindServerActions } from "@/lib/entitlements/inventory";
import { logger } from "@/lib/logger";
import { POST_ONBOARDING_PATH } from "@/lib/onboarding/activation";
import { createClient } from "@/lib/supabase/server";

// Load-time binding. A "use server" module may export only async functions,
// so this array is not exported.
bindServerActions(["auth.session", "profile.own"]);

export interface AuthActionState {
  error?: string;
  message?: string;
  /** Same-origin path. The client navigates; `redirect()` is not used here. */
  redirectTo?: string;
}

const SIGNUP_ERROR = "Could not create the account.";
const PASSWORD_UPDATE_ERROR = "Could not update the password.";

const credentials = z.object({
  email: z.string().email("Enter a valid email."),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    try {
      const { syncOnCreatorLoginServer } = await import("@/lib/gmail/sync/on-login.server");
      await syncOnCreatorLoginServer(user.id);
    } catch (syncError) {
      logger.warn("gmail incremental sync on login failed", {
        code: syncError instanceof Error ? syncError.name : "sync_failed",
      });
    }
  }
  redirect(safeRedirect(formData.get("redirect"), getClientEnv().NEXT_PUBLIC_SITE_URL));
}

export async function signUp(_prev: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const parsed = credentials.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    const env = getClientEnv();
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signUp({
      ...parsed.data,
      options: {
        emailRedirectTo: `${env.NEXT_PUBLIC_SITE_URL}/auth/callback?next=/onboarding`,
      },
    });

    if (error) {
      logger.warn("signup rejected", {
        code: String(error.code || error.name || error.status || "signup_rejected"),
      });
      return { error: SIGNUP_ERROR };
    }

    // With email confirmations enabled the user must confirm first; otherwise a
    // session is created immediately. The public.users + creator_profiles rows are
    // provisioned by the handle_new_user DB trigger (role forced to 'creator').
    // The browser navigates after this response so the session cookie is already
    // stored. `redirect()` renders /onboarding inside this action, before that
    // cookie is on the request, and requireUser then throws.
    if (data.session) {
      return { redirectTo: "/onboarding" };
    }
    return { message: "Check your email to confirm your account." };
  } catch (error) {
    unstable_rethrow(error);
    logger.error("signup failed", {
      code: error instanceof Error ? error.name : "signup_failed",
    });
    return { error: SIGNUP_ERROR };
  }
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
    logger.warn("password update failed", {
      code: String(error.code || error.name || "password_update_failed"),
    });
    return { error: PASSWORD_UPDATE_ERROR };
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
    return { redirectTo: "/login" };
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
  return { redirectTo: POST_ONBOARDING_PATH };
}
