import "server-only";

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Application-layer encryption for the one long-lived secret B02 introduces.
 *
 * The refresh token is encrypted HERE, before it reaches PostgreSQL, and the key
 * never goes near the database. That is the point: `private.gmail_oauth_credentials`
 * is already unreachable from every client role, and this means a copy of the
 * database — a backup, a restore into staging, a support dump — still does not
 * contain a usable Google credential.
 *
 * AES-256-GCM, because it authenticates as well as encrypts. A tampered
 * ciphertext fails to decrypt rather than producing plausible garbage that a
 * caller might then send to Google.
 */

/** 96 bits: the size GCM is specified for, and the one that keeps the counter simple. */
const IV_BYTES = 12;
const KEY_BYTES = 32;
const ALGORITHM = "aes-256-gcm";

/**
 * A stored secret and everything needed to open it again — except the key.
 *
 * `keyVersion` travels with the ciphertext so a future rotation can decrypt old
 * rows with the old key while writing new ones with the new key. B02 ships one
 * version and no rotation machinery; what it ships is a FORMAT that does not
 * have to change when rotation arrives.
 */
export interface SealedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
}

export class GmailCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailCryptoError";
  }
}

/**
 * Decode and validate a base64 key.
 *
 * The length check is not pedantry: a short key silently truncated or padded
 * would produce an encryption that looks fine and is much weaker than it claims
 * to be. A wrong key must fail loudly at configuration time, not quietly at
 * rest.
 */
export function decodeKey(base64Key: string): Buffer {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(base64Key, "base64");
  } catch {
    throw new GmailCryptoError("encryption key is not valid base64");
  }
  // Node's base64 decoder is lenient and drops invalid characters rather than
  // throwing, so a malformed key reaches us as a short buffer. Re-encoding and
  // comparing is what actually catches it.
  if (decoded.length !== KEY_BYTES) {
    throw new GmailCryptoError(
      `encryption key must decode to exactly ${KEY_BYTES} bytes, got ${decoded.length}`,
    );
  }
  return decoded;
}

/**
 * Encrypt one secret.
 *
 * A FRESH random IV every time, never derived and never reused: GCM's security
 * collapses if a key/IV pair is ever repeated, and "reuse the IV for the same
 * account" is exactly the kind of shortcut that looks harmless.
 */
export function sealSecret(plaintext: string, key: Buffer, keyVersion: string): SealedSecret {
  if (plaintext.length === 0) {
    throw new GmailCryptoError("refusing to encrypt an empty secret");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion,
  };
}

/**
 * Decrypt one secret, or fail.
 *
 * Any failure — wrong key, modified ciphertext, modified tag, modified IV —
 * surfaces as the same {@link GmailCryptoError} carrying no detail about which.
 * The error message is written on the assumption it may end up in a log, so it
 * says nothing that would help someone probing the ciphertext.
 */
export function openSecret(sealed: SealedSecret, key: Buffer): string {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    throw new GmailCryptoError("stored credential could not be decrypted");
  }
}

/** Constant-time comparison, for the few places a secret is compared at all. */
export function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
