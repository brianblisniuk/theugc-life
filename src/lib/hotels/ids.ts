/**
 * Identifier validation for hotel routes.
 *
 * The authenticated hotel workspace is keyed by UUID (ROUTES.md §4). Validating
 * the shape before querying keeps malformed URLs from reaching the database and
 * lets the page render a clean not-found instead of surfacing a driver error.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a syntactically valid UUID. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
