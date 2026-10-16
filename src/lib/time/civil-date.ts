/**
 * A creator's calendar day. Trip windows, follow-up labels, and deliverable
 * due dates use this day, not the UTC date of an instant. An invalid zone
 * falls back to UTC.
 */
export function civilDate(
  instant: Date | string,
  timeZone: string | null | undefined,
): string | null {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(date.getTime())) return null;
  const requested = typeof timeZone === "string" ? timeZone.trim() : "";
  const zone = requested.length > 0 ? requested : "UTC";
  const formatted = formatCivil(date, zone);
  if (formatted) return formatted;
  if (zone !== "UTC") return formatCivil(date, "UTC");
  return null;
}

function formatCivil(date: Date, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (!year || !month || !day) return null;
    return `${year}-${month}-${day}`;
  } catch {
    return null;
  }
}
