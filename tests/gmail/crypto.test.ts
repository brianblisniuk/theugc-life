import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  GmailCryptoError,
  decodeKey,
  openSecret,
  sealSecret,
  secretsEqual,
} from "@/lib/gmail/crypto.server";

/**
 * B02 introduces the first long-lived secret in this system, so the envelope
 * around it gets its own focused suite. The interesting properties are the
 * failures: a wrong key and a tampered ciphertext must both refuse, and refuse
 * the same way, rather than returning plausible garbage that a caller would then
 * send to Google.
 */

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);
const VERSION = "v1";

describe("B02 refresh-token encryption", () => {
  it("round-trips a secret", () => {
    const sealed = sealSecret("1//refresh-token-value", KEY_A, VERSION);
    expect(openSecret(sealed, KEY_A)).toBe("1//refresh-token-value");
  });

  it("never stores the plaintext in the envelope", () => {
    const plaintext = "1//a-very-recognisable-refresh-token";
    const sealed = sealSecret(plaintext, KEY_A, VERSION);
    const serialized = JSON.stringify(sealed);
    expect(serialized).not.toContain(plaintext);
    expect(serialized).not.toContain("refresh-token");
  });

  it("uses a FRESH IV for every encryption", () => {
    // GCM's security collapses if a key/IV pair repeats. Encrypting the same
    // value twice must produce two different IVs and two different ciphertexts.
    const first = sealSecret("same-value", KEY_A, VERSION);
    const second = sealSecret("same-value", KEY_A, VERSION);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("fails authentication under the wrong key", () => {
    const sealed = sealSecret("secret", KEY_A, VERSION);
    expect(() => openSecret(sealed, KEY_B)).toThrow(GmailCryptoError);
  });

  it("fails authentication when the ciphertext is modified", () => {
    const sealed = sealSecret("secret", KEY_A, VERSION);
    const bytes = Buffer.from(sealed.ciphertext, "base64");
    bytes[0] = bytes[0]! ^ 0xff;
    expect(() => openSecret({ ...sealed, ciphertext: bytes.toString("base64") }, KEY_A)).toThrow(
      GmailCryptoError,
    );
  });

  it("fails authentication when the tag or IV is modified", () => {
    const sealed = sealSecret("secret", KEY_A, VERSION);
    const tag = Buffer.from(sealed.authTag, "base64");
    tag[0] = tag[0]! ^ 0xff;
    expect(() => openSecret({ ...sealed, authTag: tag.toString("base64") }, KEY_A)).toThrow(
      GmailCryptoError,
    );

    const iv = Buffer.from(sealed.iv, "base64");
    iv[0] = iv[0]! ^ 0xff;
    expect(() => openSecret({ ...sealed, iv: iv.toString("base64") }, KEY_A)).toThrow(
      GmailCryptoError,
    );
  });

  it("carries a key version so rotation does not need a format change", () => {
    expect(sealSecret("secret", KEY_A, "v1").keyVersion).toBe("v1");
    expect(sealSecret("secret", KEY_A, "v2").keyVersion).toBe("v2");
  });

  it("refuses a key that is not exactly 32 bytes", () => {
    expect(() => decodeKey(randomBytes(31).toString("base64"))).toThrow(/32 bytes/);
    expect(() => decodeKey(randomBytes(33).toString("base64"))).toThrow(/32 bytes/);
    // Node's base64 decoder silently drops invalid characters rather than
    // throwing, so garbage arrives as a short buffer — caught by the same check.
    expect(() => decodeKey("not-base64!!!")).toThrow(/32 bytes/);
    expect(decodeKey(KEY_A.toString("base64"))).toHaveLength(32);
  });

  it("refuses to encrypt an empty secret", () => {
    expect(() => sealSecret("", KEY_A, VERSION)).toThrow(GmailCryptoError);
  });

  it("says nothing about WHY decryption failed", () => {
    // The message may reach a log, so it must not help someone probing.
    const sealed = sealSecret("secret", KEY_A, VERSION);
    try {
      openSecret(sealed, KEY_B);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toBe("stored credential could not be decrypted");
    }
  });

  it("compares secrets without leaking length-independent timing", () => {
    expect(secretsEqual("abc", "abc")).toBe(true);
    expect(secretsEqual("abc", "abd")).toBe(false);
    expect(secretsEqual("abc", "abcd")).toBe(false);
  });
});
