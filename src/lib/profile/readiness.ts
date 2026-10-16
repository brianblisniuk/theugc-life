/**
 * Hotel-facing readiness. A missing field is not done. Follower counts are not
 * a requirement.
 */
export interface ReadinessItem {
  id: "intro" | "pieces" | "formats" | "link";
  label: string;
  done: boolean;
}

export function profileReadiness(input: {
  bio: string;
  formats: string;
  languages: string;
  selectedCount: number;
  shareLinkUsable: boolean;
}): { ready: boolean; items: ReadinessItem[] } {
  const intro = input.bio.trim().length > 0;
  const pieces = Number.isInteger(input.selectedCount) && input.selectedCount > 0;
  const formats = input.formats.trim().length > 0 || input.languages.trim().length > 0;
  const link = input.shareLinkUsable;
  const items: ReadinessItem[] = [
    { id: "intro", label: "Clear description of creative work", done: intro },
    {
      id: "pieces",
      label: pieces
        ? `${input.selectedCount} selected piece${input.selectedCount === 1 ? "" : "s"}`
        : "Selected pieces recorded",
      done: pieces,
    },
    { id: "formats", label: "Languages and formats listed", done: formats },
    { id: "link", label: "Portfolio link to share", done: link },
  ];
  return { ready: items.every((item) => item.done), items };
}
