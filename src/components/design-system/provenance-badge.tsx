import { provenanceBadge, type ProvenanceId } from "@/lib/design-system/states";

const TONE: Record<ProvenanceId, "green" | "amber" | "gray" | "blue"> = {
  gmail: "green",
  manual: "amber",
  sample: "gray",
  pending: "blue",
};

export function ProvenanceBadge({ id }: { id: ProvenanceId }) {
  const badge = provenanceBadge(id);
  return (
    <span className={`v12-pill is-${TONE[id]}`} data-provenance={id}>
      {badge.label}
    </span>
  );
}
