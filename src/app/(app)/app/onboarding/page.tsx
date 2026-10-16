import { DestinationQuestion } from "@/components/onboarding/destination-question";
import { requireUser } from "@/lib/auth/guards";
import { listDestinations } from "@/lib/trips/queries";

export const metadata = { title: "Destination" };

export default async function OnboardingDestinationPage() {
  await requireUser("/app/onboarding");
  const catalog = await listDestinations();
  if (catalog.status !== "ok") {
    return (
      <p className="max-w-prose text-sm">
        We could not load destinations. Reload the page. This is not an empty catalog.
      </p>
    );
  }
  return (
    <DestinationQuestion
      destinations={catalog.destinations.map((destination) => ({
        id: destination.id,
        name: destination.name,
        slug: destination.slug,
        countryCode: null,
      }))}
    />
  );
}
