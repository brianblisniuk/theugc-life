"use client";

import { useState } from "react";

import {
  createShareLink,
  revokeShareLink,
  rotateShareLink,
  type ShareLinkResult,
} from "@/lib/profile/share-actions";
import type { OwnShareLink } from "@/lib/profile/share-contract";

const FIELD =
  "w-full rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text";

function messageFor(result: ShareLinkResult): string | null {
  switch (result.result) {
    case "created":
    case "rotated":
      return null;
    case "revoked":
      return "Revoked. That address no longer works.";
    case "active_link_exists":
      return "A link is already active. Rotate it to replace the address.";
    case "not_found":
      return "There is no active link to change.";
    case "invalid_input":
      return result.message;
    case "error":
      return "We couldn’t update the link. Try again.";
    default:
      return null;
  }
}

function ExpiryField() {
  return (
    <label className="block space-y-1 text-xs font-medium text-muted">
      Expiry date, optional
      <input className={FIELD} type="date" name="expiresOn" />
    </label>
  );
}

export function ShareLinkPanel({ link }: { link: OwnShareLink | null }) {
  const [token, setToken] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onCreate(formData: FormData) {
    setPending(true);
    const result = await createShareLink(formData);
    setPending(false);
    setNotice(messageFor(result));
    setToken(result.result === "created" ? result.token : null);
  }

  async function onRotate(formData: FormData) {
    setPending(true);
    const result = await rotateShareLink(formData);
    setPending(false);
    setNotice(messageFor(result));
    setToken(result.result === "rotated" ? result.token : null);
  }

  async function onRevoke() {
    setPending(true);
    const result = await revokeShareLink();
    setPending(false);
    setNotice(messageFor(result));
    setToken(null);
  }

  const shown = token ? `${window.location.origin}/p/${token}` : null;
  const active = link?.usable === true && !token;

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-text">Hotel link</h2>
        <p className="max-w-prose text-sm text-muted">
          This is the only way a hotel sees the fields you turn on. We store a hash of the address,
          not the address itself. Copy it when it is created. Rotating or revoking stops the old
          address immediately.
        </p>
      </div>

      {shown ? (
        <div className="space-y-2 rounded-[var(--radius-app)] border border-border bg-surface p-4">
          <p className="text-sm font-medium text-text">
            Copy this link now. It will not be shown again.
          </p>
          <p className="break-all font-mono text-sm text-text">{shown}</p>
        </div>
      ) : null}

      {link && !link.usable && !link.revokedAt ? (
        <p className="text-sm text-muted">
          This link has expired. Rotate it to issue a new address.
        </p>
      ) : null}
      {link?.usable ? (
        <p className="text-sm text-muted">
          A link is active
          {link.expiresAt ? ` until ${link.expiresAt.slice(0, 10)}` : ", with no expiry"}. The
          address was shown when it was created.
        </p>
      ) : null}
      {link?.revokedAt && !shown ? (
        <p className="text-sm text-muted">The last link is revoked.</p>
      ) : null}

      {!active ? (
        <form action={onCreate} className="flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1">
            <ExpiryField />
          </div>
          <button
            type="submit"
            disabled={pending}
            className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast disabled:opacity-60"
          >
            {pending ? "Working…" : "Create link"}
          </button>
        </form>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <form action={onRotate} className="flex flex-wrap items-end gap-3">
            <div className="min-w-48">
              <ExpiryField />
            </div>
            <button
              type="submit"
              disabled={pending}
              className="inline-flex rounded-[var(--radius-app)] border border-border px-4 py-2 text-sm font-semibold text-text disabled:opacity-60"
            >
              Rotate link
            </button>
          </form>
          <form action={onRevoke}>
            <button
              type="submit"
              disabled={pending}
              className="inline-flex rounded-[var(--radius-app)] border border-border px-4 py-2 text-sm font-semibold text-text disabled:opacity-60"
            >
              Revoke link
            </button>
          </form>
        </div>
      )}

      {notice ? (
        <p className="text-sm text-text" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
