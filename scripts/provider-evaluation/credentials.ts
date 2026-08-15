/**
 * Credential presence checks.
 *
 * The ONLY thing this module ever reports outward is AVAILABLE / NOT AVAILABLE.
 * Values are read for request signing and never returned, logged or serialised.
 */

export type CredentialStatus = "AVAILABLE" | "NOT AVAILABLE";

export interface CredentialReport {
  provider: string;
  /** Env var name → presence. Never the value. */
  variables: Record<string, CredentialStatus>;
  allPresent: boolean;
}

export function checkCredentials(
  provider: string,
  envVarNames: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CredentialReport {
  const variables: Record<string, CredentialStatus> = {};
  for (const name of envVarNames) {
    const value = env[name];
    variables[name] = value && value.trim().length > 0 ? "AVAILABLE" : "NOT AVAILABLE";
  }
  return {
    provider,
    variables,
    allPresent: envVarNames.length > 0 && Object.values(variables).every((s) => s === "AVAILABLE"),
  };
}

/**
 * Read a credential for actual use.
 *
 * Separate from the reporting path on purpose: the report can be serialised
 * freely, this cannot. Throws rather than returning a partial/undefined value,
 * so a missing credential fails loudly at startup instead of producing an
 * unauthenticated request whose empty result looks like "the destination has no
 * hotels".
 */
export function requireCredential(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required credential env var: ${name} (value not shown)`);
  }
  return value;
}
