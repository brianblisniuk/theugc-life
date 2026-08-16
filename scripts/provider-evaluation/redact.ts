/**
 * Secret redaction for the evaluation harness.
 *
 * The harness authenticates to third-party APIs, so every path that could reach
 * a log, an artifact file or an error message goes through here first. This is
 * defence in depth rather than politeness: a provider key pasted into a bug
 * report is a real incident, and the most common way it happens is an error
 * object that happened to carry the request headers.
 */

/** Env var name fragments whose values must never be printed. */
const SECRET_NAME_PATTERNS = [
  /TOKEN/i,
  /SECRET/i,
  /KEY/i,
  /PASSWORD/i,
  /CREDENTIAL/i,
  /AUTHORIZATION/i,
];

export const REDACTED = "[REDACTED]";

export function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERNS.some((p) => p.test(name));
}

/**
 * Redact known secret VALUES out of arbitrary text.
 *
 * Value-based rather than name-based, because by the time a secret reaches a
 * log line it has usually lost the name it was stored under — it is inside a
 * URL, a header dump or a stack trace.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    // Very short values would match everywhere and turn output into noise; they
    // are also not plausible credentials.
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Collect the current process's secret-looking env values, for redaction. */
export function collectSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value && isSecretName(name)) values.push(value);
  }
  return values;
}

/**
 * Deep-redact an object destined for an artifact file or a console.
 *
 * Redacts by key name as well as by value, so a header object survives the trip
 * with its shape intact and its contents gone.
 */
export function redactObject(input: unknown, secrets: readonly string[]): unknown {
  if (typeof input === "string") return redactSecrets(input, secrets);
  if (Array.isArray(input)) return input.map((v) => redactObject(v, secrets));
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = isSecretName(key) ? REDACTED : redactObject(value, secrets);
    }
    return out;
  }
  return input;
}

/** Console logger that cannot leak a credential. */
export function createSafeLogger(secrets: readonly string[]) {
  return (...parts: unknown[]): void => {
    const line = parts
      .map((p) => (typeof p === "string" ? p : JSON.stringify(redactObject(p, secrets))))
      .join(" ");
    // eslint-disable-next-line no-console -- this is a CLI harness
    console.log(redactSecrets(line, secrets));
  };
}
