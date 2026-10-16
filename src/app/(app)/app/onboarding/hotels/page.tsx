import Link from "next/link";
import { redirect } from "next/navigation";

import { UnlockContact } from "@/components/contacts/unlock-contact";
import { SaveFirstHotelButton } from "@/components/onboarding/save-first-hotel";
import { requireUser } from "@/lib/auth/guards";
import { parseDiscoverQuery } from "@/lib/hotels/filters";
import {
  getHotelContactsIfAuthorized,
  getPublicCardSignals,
  searchHotels,
} from "@/lib/hotels/queries";
import { nearbyDestinations } from "@/lib/onboarding/destination";
import { FIRST_RUN_COPY } from "@/lib/onboarding/first-run";
import {
  contactLabel,
  onboardingContact,
  onboardingContext,
  rankOnboardingHotels,
  type RankedHotel,
} from "@/lib/onboarding/hotel-cards";

type OnboardingCard = RankedHotel & {
  unlocked: boolean;
  balance: number | null;
  cost: number;
};
import { loadHomeProgress } from "@/lib/onboarding/queries";
import { listDestinations } from "@/lib/trips/queries";

export const metadata = { title: "First hotels" };

export default async function OnboardingHotelsPage() {
  const session = await requireUser("/app/onboarding/hotels");
  const progress = await loadHomeProgress(session.userId);
  if (progress.facts.destination === "error") {
    return (
      <p className="text-sm">
        We could not read the destination you chose. Reload the page. This is not “no hotels”.
      </p>
    );
  }
  if (progress.facts.destination !== "yes" || !progress.destinationSlug) {
    redirect("/app/onboarding");
  }

  let failed = false;
  let hotels: OnboardingCard[] = [];
  try {
    const found = await searchHotels(
      parseDiscoverQuery({ destination: progress.destinationSlug, pageSize: "6" }),
    );
    const signals = await getPublicCardSignals(found.hotels.map((hotel) => hotel.id));
    const cards = await Promise.all(
      found.hotels.map(async (hotel) => {
        const loaded = await getHotelContactsIfAuthorized(hotel.id);
        const ownsUnlock = loaded.via === "unlock" && loaded.access.status === "allowed";
        const contact = loaded.failed
          ? onboardingContact("error", null)
          : onboardingContact(
              ownsUnlock ? "allowed" : loaded.access.status === "error" ? "error" : "denied",
              ownsUnlock ? loaded.contacts : null,
            );
        const signal = signals?.get(hotel.id) ?? null;
        const context = onboardingContext(signal, signals === null);
        const zone = [hotel.destination?.name, hotel.countryCode].filter(Boolean).join(", ");
        return {
          id: hotel.id,
          name: hotel.name,
          zone: zone || null,
          contact,
          context: context.text,
          verified: contact.kind === "verified",
          signalScore: context.score,
          unlocked: ownsUnlock,
          balance: loaded.balance,
          cost: loaded.cost,
        };
      }),
    );
    hotels = rankOnboardingHotels(cards).slice(0, 6);
  } catch {
    failed = true;
  }

  const catalog = await listDestinations();
  const nearby =
    catalog.status === "ok"
      ? nearbyDestinations(
          catalog.destinations.map((destination) => ({
            id: destination.id,
            name: destination.name,
            slug: destination.slug,
            countryCode: null,
          })),
          null,
        ).filter((destination) => destination.slug !== progress.destinationSlug)
      : [];

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.1em] text-muted">
          {progress.destinationName}
        </p>
        <h1 className="text-3xl font-extrabold tracking-tight">Hotels for your destination</h1>
        <p className="mt-2 text-sm text-muted">{FIRST_RUN_COPY.databaseNote}</p>
      </div>

      {failed ? (
        <p className="text-sm">
          We could not load hotels. Reload the page. This is not a destination with no data.
        </p>
      ) : hotels.length === 0 ? (
        <div className="space-y-4">
          <h2 className="text-xl font-extrabold">{FIRST_RUN_COPY.insufficientTitle}</h2>
          <p className="max-w-prose text-sm text-muted">{FIRST_RUN_COPY.insufficientBody}</p>
          {nearby.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {nearby.map((destination) => (
                <Link
                  key={destination.id}
                  href={`/app/discover?destination=${destination.slug}`}
                  className="rounded-md border border-border px-3 py-1.5 text-sm font-semibold"
                >
                  {destination.name}
                </Link>
              ))}
            </div>
          ) : null}
          <Link
            href="/app/discover"
            className="inline-flex rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
          >
            Add the first hotel
          </Link>
        </div>
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {hotels.map((hotel) => {
            const label = contactLabel(hotel.contact);
            return (
              <li
                key={hotel.id}
                className="grid gap-3 py-3 sm:grid-cols-[1fr_auto] sm:items-center"
              >
                <div>
                  <h2 className="text-lg font-extrabold">
                    <Link href={`/app/hotels/${hotel.id}`} className="hover:underline">
                      {hotel.name}
                    </Link>
                  </h2>
                  {hotel.zone ? <p className="text-[13px] text-muted">{hotel.zone}</p> : null}
                  {label ? (
                    <p className="mt-1 text-sm font-semibold text-success">{label}</p>
                  ) : null}
                  {hotel.context ? <p className="text-xs text-muted">{hotel.context}</p> : null}
                </div>
                <div className="flex flex-col items-start gap-2 sm:items-end">
                  <UnlockContact
                    hotelId={hotel.id}
                    unlocked={hotel.unlocked}
                    balance={hotel.balance}
                    cost={hotel.cost}
                    showEmail={false}
                  />
                  <SaveFirstHotelButton hotelId={hotel.id} />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Link href="/app" className="inline-block text-sm text-muted underline">
        Back to home
      </Link>
    </div>
  );
}
