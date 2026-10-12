"use client";

/**
 * Private profile form. It posts the fields the creator typed. It does not
 * post a user id, a public-profile flag, or a portfolio visibility.
 */
import { useState } from "react";
import { useFormStatus } from "react-dom";

import { updateCreatorProfile, type ProfileSaveResult } from "@/lib/profile/actions";
import type { CreatorProfileFields } from "@/lib/profile/contract";

const FIELD =
  "w-full rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text";
const LABEL = "block text-xs font-medium text-muted";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast disabled:opacity-60"
    >
      {pending ? "Saving…" : "Save profile"}
    </button>
  );
}

function saveMessage(result: ProfileSaveResult): string | null {
  switch (result.result) {
    case "saved":
      return "Saved.";
    case "invalid_input":
      return result.message;
    case "username_taken":
      return "That username is taken. Try another.";
    case "error":
      return "We couldn’t save your profile. Try again.";
    default:
      return null;
  }
}

function Field({
  id,
  name,
  label,
  defaultValue,
  hint,
  autoComplete,
}: {
  id: string;
  name: string;
  label: string;
  defaultValue: string;
  hint?: string;
  autoComplete?: string;
}) {
  return (
    <div className="space-y-1">
      <label className={LABEL} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        name={name}
        defaultValue={defaultValue}
        autoComplete={autoComplete}
        className={FIELD}
      />
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function ProfileEditor({ profile }: { profile: CreatorProfileFields }) {
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(formData: FormData) {
    const result = await updateCreatorProfile(formData);
    setMessage(saveMessage(result));
  }

  return (
    <form action={onSubmit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          id="displayName"
          name="displayName"
          label="Display name"
          defaultValue={profile.displayName}
          autoComplete="name"
        />
        <Field
          id="username"
          name="username"
          label="Username"
          defaultValue={profile.username}
          autoComplete="username"
        />
        <div className="space-y-1 sm:col-span-2">
          <label className={LABEL} htmlFor="bio">
            Bio
          </label>
          <textarea id="bio" name="bio" defaultValue={profile.bio} rows={3} className={FIELD} />
        </div>
        <Field id="homeCity" name="homeCity" label="Home city" defaultValue={profile.homeCity} />
        <Field
          id="homeCountry"
          name="homeCountry"
          label="Home country"
          defaultValue={profile.homeCountry}
        />
        <Field
          id="primaryLanguage"
          name="primaryLanguage"
          label="Primary language"
          defaultValue={profile.primaryLanguage}
        />
        <Field
          id="languages"
          name="languages"
          label="Languages"
          defaultValue={profile.languages}
          hint="Separate with commas."
        />
        <Field
          id="creatorNiches"
          name="creatorNiches"
          label="Niches"
          defaultValue={profile.creatorNiches}
          hint="Separate with commas."
        />
        <Field
          id="contentFormats"
          name="contentFormats"
          label="Content formats"
          defaultValue={profile.contentFormats}
          hint="Separate with commas."
        />
        <Field
          id="instagramHandle"
          name="instagramHandle"
          label="Instagram handle"
          defaultValue={profile.instagramHandle}
        />
        <Field
          id="instagramUrl"
          name="instagramUrl"
          label="Instagram link"
          defaultValue={profile.instagramUrl}
        />
        <Field
          id="tiktokHandle"
          name="tiktokHandle"
          label="TikTok handle"
          defaultValue={profile.tiktokHandle}
        />
        <Field
          id="tiktokUrl"
          name="tiktokUrl"
          label="TikTok link"
          defaultValue={profile.tiktokUrl}
        />
        <Field
          id="youtubeUrl"
          name="youtubeUrl"
          label="YouTube link"
          defaultValue={profile.youtubeUrl}
        />
        <Field
          id="websiteUrl"
          name="websiteUrl"
          label="Website"
          defaultValue={profile.websiteUrl}
        />
        <div className="sm:col-span-2">
          <Field
            id="profilePhotoUrl"
            name="profilePhotoUrl"
            label="Profile photo link"
            defaultValue={profile.profilePhotoUrl}
            hint="An https link. This page does not upload a file."
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton />
        {message ? (
          <p className="text-sm text-text" role="status">
            {message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
