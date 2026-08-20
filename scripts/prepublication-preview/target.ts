import { classifyDatabaseUrl, type TargetClassification } from "../../src/lib/import/preflight";

export class PreviewTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewTargetError";
  }
}

export interface PreviewTarget {
  url: string;
  classification: TargetClassification;
}

/** Read-only inspection target. Unlike ingestion, hosted databases are valid. */
export function resolvePreviewTarget(env: Record<string, string | undefined>): PreviewTarget {
  const url = env.DATABASE_URL?.trim() || env.TEST_DATABASE_URL?.trim();
  if (!url)
    throw new PreviewTargetError(
      "No preview database configured; set DATABASE_URL or TEST_DATABASE_URL.",
    );
  const classification = classifyDatabaseUrl(url);
  if (classification.hostClass === "unknown") {
    throw new PreviewTargetError(
      `Cannot classify preview database (${classification.redactedTarget}).`,
    );
  }
  return { url, classification };
}
