/**
 * Evaluation artifact output.
 *
 * Everything this harness writes lands under `.data/provider-evaluation/`, which
 * is gitignored. Raw provider responses and property-level extracts must never
 * reach the repository; only aggregate metrics belong in the committed report,
 * and a human copies those across deliberately.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { collectSecretValues, redactObject } from "./redact";

export const ARTIFACT_ROOT = ".data/provider-evaluation";

export function artifactPath(...parts: string[]): string {
  return resolve(process.cwd(), join(ARTIFACT_ROOT, ...parts));
}

/**
 * Write a JSON artifact, deep-redacted.
 *
 * Redaction runs even here — an artifact containing a request header is exactly
 * the kind of file that later gets attached to a ticket.
 */
export function writeArtifact(relativePath: string, data: unknown): string {
  const target = artifactPath(relativePath);
  mkdirSync(dirname(target), { recursive: true });
  const safe = redactObject(data, collectSecretValues());
  writeFileSync(target, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  return target;
}
