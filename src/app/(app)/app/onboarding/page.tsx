import { DestinationQuestion } from "@/components/onboarding/destination-question";
import { requireUser } from "@/lib/auth/guards";
import { listDestinations } from "@/lib/trips/queries";

export const metadata = { title: "Destino" };

export default async function OnboardingDestinationPage() {
  await requireUser("/app/onboarding");
  const catalog = await listDestinations();
  if (catalog.status !== "ok") {
    return (
      <p className="max-w-prose text-sm">
        No pudimos cargar los destinos. Recargá la página. Esto no es un catálogo vacío.
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
