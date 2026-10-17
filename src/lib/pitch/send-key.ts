/**
 * The pitch Send button keeps one idempotency key (D157).
 * The key is stored with the bound draft, and with the opportunity when the
 * draft id is not on the page yet. A reload reads that key back.
 * A definite non-send failure may replace it. `unknown` and `sent` must not.
 */

const SEND_KEY = /^[A-Za-z0-9_-]{16,80}$/;

export const PITCH_SEND_KEY_PREFIX = "theugc.pitch-send-key:";

export interface PitchSendKeyStore {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

export function isPitchSendKey(value: string | null | undefined): value is string {
  return typeof value === "string" && SEND_KEY.test(value);
}

function scopeName(kind: "draft" | "opportunity", id: string | null | undefined): string | null {
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  return `${PITCH_SEND_KEY_PREFIX}${kind}:${trimmed}`;
}

/** Draft scope wins. The opportunity scope covers a send made before the draft id existed. */
export function readPitchSendKey(
  store: PitchSendKeyStore | null,
  draftId: string | null,
  opportunityId: string | null,
): string | null {
  if (!store) return null;
  const names = [scopeName("draft", draftId), scopeName("opportunity", opportunityId)];
  for (const name of names) {
    if (!name) continue;
    let value: string | null = null;
    try {
      value = store.getItem(name);
    } catch {
      value = null;
    }
    if (isPitchSendKey(value)) return value;
  }
  return null;
}

/** Writes the key onto every scope this send can be found by after a reload. */
export function writePitchSendKey(
  store: PitchSendKeyStore | null,
  input: { draftId: string | null; opportunityId: string | null; key: string },
): void {
  if (!store || !isPitchSendKey(input.key)) return;
  const names = [scopeName("draft", input.draftId), scopeName("opportunity", input.opportunityId)];
  for (const name of names) {
    if (!name) continue;
    try {
      store.setItem(name, input.key);
    } catch {
      // The in-memory key still covers this document.
    }
  }
}

export function browserPitchSendKeyStore(): PitchSendKeyStore | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const storage = window.localStorage;
    return {
      getItem: (name) => {
        try {
          return storage.getItem(name);
        } catch {
          return null;
        }
      },
      setItem: (name, value) => {
        try {
          storage.setItem(name, value);
        } catch {
          // Private mode can refuse the write. The ref still holds the key.
        }
      },
      removeItem: (name) => {
        try {
          storage.removeItem(name);
        } catch {
          // Nothing else to clear.
        }
      },
    };
  } catch {
    return null;
  }
}
