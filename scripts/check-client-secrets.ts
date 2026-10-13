/**
 * Fail when a server secret name, or the CI service-role sentinel, is in the
 * client bundle. NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is the one allowed name.
 * This script never prints a secret value.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FORBIDDEN_CLIENT_IDENTIFIERS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GMAIL_TOKEN_ENCRYPTION_KEY_V1",
  "GMAIL_TOKEN_ENCRYPTION_KEY",
  "BILLING_WEBHOOK_SECRET",
  "DATABASE_URL",
  "TEST_DATABASE_URL",
] as const;

export const ALLOWED_PUBLIC_SECRET_NAME = "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY";

const SENTINEL = "ci-service-role-key";

export interface BundleFinding {
  file: string;
  identifier: string;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (name.endsWith(".js")) out.push(full);
  }
}

export function scanClientBundle(
  staticDir: string,
  extraForbidden: readonly string[] = [],
): BundleFinding[] {
  const files: string[] = [];
  walk(staticDir, files);
  const extras = extraForbidden.filter((value) => value.length >= 20);
  const findings: BundleFinding[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const identifier of FORBIDDEN_CLIENT_IDENTIFIERS) {
      if (source.includes(identifier)) findings.push({ file, identifier });
    }
    if (source.includes(SENTINEL)) findings.push({ file, identifier: "service_role_sentinel" });
    for (const value of extras) {
      if (source.includes(value)) findings.push({ file, identifier: "extra_forbidden_value" });
    }
    if (source.includes(ALLOWED_PUBLIC_SECRET_NAME)) {
      // The public Maps key name may appear. Its value is never printed.
    }
  }
  return findings;
}

const SERVICE_ROLE_KEY_NAME = "SUPABASE_SERVICE_ROLE_KEY";
const PUBLIC_SERVICE_ROLE_NAME = /NEXT_PUBLIC_[A-Z0-9_]*SERVICE_ROLE[A-Z0-9_]*/;
const PUBLIC_ASSIGNED_FROM_SERVICE_ROLE =
  /NEXT_PUBLIC_[A-Z0-9_]+\s*[:=]\s*(?:process\.env\.)?SUPABASE_SERVICE_ROLE_KEY/;

export interface ServiceRoleReferenceFinding {
  file: string;
  reason:
    | "client_component"
    | "client_import"
    | "client_env"
    | "next_public_name"
    | "next_public_assignment";
}

function directive(source: string, name: "use client" | "use server"): boolean {
  const stripped = source
    .replace(/^\uFEFF/, "")
    .replace(/^(?:\s*\/\*[\s\S]*?\*\/\s*)/, "")
    .replace(/^(?:\s*\/\/.*\n)+/, "")
    .trimStart();
  return new RegExp(`^["']${name}["']\\s*;?`).test(stripped);
}

function sourceFiles(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) sourceFiles(full, out);
    else if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(name)) out.push(full);
  }
}

function importSpecifiers(source: string): string[] {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const specs: string[] = [];
  for (const match of withoutBlocks.matchAll(
    /(?:^|\n)\s*import\s+(?!type\b)[\s\S]*?\sfrom\s*["']([^"']+)["']/g,
  )) {
    const spec = match[1];
    if (spec) specs.push(spec);
  }
  for (const match of withoutBlocks.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) {
    const spec = match[1];
    if (spec) specs.push(spec);
  }
  for (const match of withoutBlocks.matchAll(
    /(?:^|\n)\s*export\s+(?!type\b)[\s\S]*?\sfrom\s*["']([^"']+)["']/g,
  )) {
    const spec = match[1];
    if (spec) specs.push(spec);
  }
  return specs;
}

function resolveSource(fromFile: string, spec: string, srcRoot: string): string | null {
  const target = spec.startsWith("@/")
    ? path.join(srcRoot, spec.slice(2))
    : spec.startsWith(".")
      ? path.resolve(path.dirname(fromFile), spec)
      : null;
  if (!target) return null;
  const candidates = [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    `${target}.js`,
    `${target}.jsx`,
    `${target}.mjs`,
    path.join(target, "index.ts"),
    path.join(target, "index.tsx"),
    path.join(target, "index.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

/**
 * The service-role key name may exist in server modules. It must not appear in
 * a client component, in a module a client component bundles, in the client
 * env module, or as a NEXT_PUBLIC_ variable.
 */
export function scanServiceRoleReferences(root: string): ServiceRoleReferenceFinding[] {
  const srcRoot = path.join(root, "src");
  const files: string[] = [];
  sourceFiles(srcRoot, files);
  const clientEntries = new Set<string>();
  const findings: ServiceRoleReferenceFinding[] = [];
  const seenFiles = new Set<string>();

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (directive(source, "use client")) clientEntries.add(file);
    if (PUBLIC_SERVICE_ROLE_NAME.test(source)) {
      findings.push({ file, reason: "next_public_name" });
    }
    if (PUBLIC_ASSIGNED_FROM_SERVICE_ROLE.test(source)) {
      findings.push({ file, reason: "next_public_assignment" });
    }
  }

  const clientEnv = path.join(srcRoot, "env.ts");
  if (existsSync(clientEnv) && readFileSync(clientEnv, "utf8").includes(SERVICE_ROLE_KEY_NAME)) {
    findings.push({ file: clientEnv, reason: "client_env" });
  }

  const queue = [...clientEntries];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    const serverBoundary = directive(source, "use server") && !directive(source, "use client");
    if (serverBoundary) continue;
    if (source.includes(SERVICE_ROLE_KEY_NAME)) {
      findings.push({
        file,
        reason: clientEntries.has(file) ? "client_component" : "client_import",
      });
    }
    for (const spec of importSpecifiers(source)) {
      const resolved = resolveSource(file, spec, srcRoot);
      if (resolved) queue.push(resolved);
    }
  }

  const example = path.join(root, ".env.example");
  if (existsSync(example)) {
    const lines = readFileSync(example, "utf8").split("\n");
    for (const line of lines) {
      const code = line.replace(/#.*/, "");
      if (PUBLIC_SERVICE_ROLE_NAME.test(code)) {
        findings.push({ file: example, reason: "next_public_name" });
      }
      if (PUBLIC_ASSIGNED_FROM_SERVICE_ROLE.test(code)) {
        findings.push({ file: example, reason: "next_public_assignment" });
      }
    }
  }

  return findings.filter((finding) => {
    const key = `${finding.file}:${finding.reason}`;
    if (seenFiles.has(key)) return false;
    seenFiles.add(key);
    return true;
  });
}

function extraFromEnv(): string[] {
  const raw = process.env.CLIENT_BUNDLE_EXTRA_FORBIDDEN ?? "";
  return raw
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function main(): void {
  const references = scanServiceRoleReferences(process.cwd());
  if (references.length > 0) {
    for (const finding of references) {
      console.error(`service role key referenced from ${finding.reason} in ${finding.file}`);
    }
    process.exit(1);
  }
  const staticDir = path.join(process.cwd(), ".next", "static");
  let findings: BundleFinding[];
  try {
    findings = scanClientBundle(staticDir, extraFromEnv());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      console.error("client bundle scan: .next/static is missing");
      process.exit(process.env.CI ? 1 : 0);
    }
    throw error;
  }
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(
        `client bundle contains forbidden identifier ${finding.identifier} in ${finding.file}`,
      );
    }
    process.exit(1);
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
