import { EmptyState } from "@/components/ui/states";
import { ButtonLink } from "@/components/ui/button";

export default function OutreachNotFound() {
  return (
    <EmptyState
      title="This outreach isn’t available"
      description="It may belong to another workspace, or it may have been deleted. Opportunities that were on it stay in your pipeline."
      action={<ButtonLink href="/app/outreach">Back to outreach</ButtonLink>}
    />
  );
}
