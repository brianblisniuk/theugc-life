import Link from "next/link";

import { DismissChecklistButton } from "@/components/onboarding/dismiss-checklist";
import { requireUser } from "@/lib/auth/guards";
import { getPublicCardSignals, searchHotels } from "@/lib/hotels/queries";
import { parseDiscoverQuery } from "@/lib/hotels/filters";
import { greeting, homeView } from "@/lib/onboarding/first-run";
import { loadHomeProgress } from "@/lib/onboarding/queries";
import { getPersonalCounts } from "@/lib/profile/queries";
import { hotelHref } from "@/lib/shell/navigation";
import { listTrips } from "@/lib/trips/queries";

const primary =
  "inline-flex rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast";
const outline =
  "inline-flex rounded-md border-[1.5px] border-[#111] px-4 py-2 text-sm font-semibold text-[#111]";

function daysUntil(start: string): number | null {
  const date = new Date(`${start}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  const utc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((date.getTime() - utc) / 86_400_000);
}

/**
 * Inicio. Direction A layout over the creator's own rows (D095).
 * Counts are creator-recorded. A missing profile is not a zero.
 */
export default async function AppHomePage() {
  const session = await requireUser("/app");
  const [progress, counts, trips] = await Promise.all([
    loadHomeProgress(session.userId),
    getPersonalCounts(),
    listTrips(),
  ]);
  const view = homeView(progress.facts);
  const next =
    trips.status === "ok"
      ? (trips.trips
          .filter((trip) => daysUntil(trip.startDate) !== null && (daysUntil(trip.startDate) ?? -1) >= 0)
          .sort((a, b) => a.startDate.localeCompare(b.startDate))[0] ?? null)
      : null;

  let recommended: { id: string; name: string; line: string }[] = [];
  if (progress.destinationSlug) {
    try {
      const found = await searchHotels(
        parseDiscoverQuery({ destination: progress.destinationSlug, pageSize: "2" }),
      );
      const signals = await getPublicCardSignals(found.hotels.map((hotel) => hotel.id));
      recommended = found.hotels.slice(0, 2).map((hotel) => {
        const signal = signals?.get(hotel.id) ?? null;
        const line = [hotel.destination?.name, hotel.countryCode, signal?.activity]
          .filter(Boolean)
          .join(" · ");
        return { id: hotel.id, name: hotel.name, line };
      });
    } catch {
      recommended = [];
    }
  }

  const remaining = view.kind === "checklist" ? view.remaining : 0;

  return (
    <div className="space-y-8">
      {next ? (
        <section className="flex h-[220px] items-end overflow-hidden rounded-md bg-[#111] md:h-[300px]">
          <div className="w-full bg-gradient-to-t from-black/55 to-transparent p-7 text-white">
            <p className="text-xs font-bold uppercase tracking-[0.1em] text-accent">
              Próximo viaje
              {daysUntil(next.startDate) !== null ? ` · en ${daysUntil(next.startDate)} días` : ""}
            </p>
            <h1 className="text-[44px] font-extrabold leading-none tracking-tight text-white md:text-[64px]">
              {next.destinationName}
            </h1>
            <p>
              {next.startDate} – {next.endDate}
              {next.name ? ` · ${next.name}` : ""}
            </p>
          </div>
        </section>
      ) : null}

      <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr]">
        <section>
          <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#666]">Para hacer ahora</p>
          <h2 className="mt-1 text-3xl font-extrabold tracking-tight">
            {view.kind === "blocked" ? view.title : greeting(progress.displayName, remaining)}
          </h2>

          {view.kind === "blocked" ? (
            <p className="mt-4 max-w-prose text-sm text-muted">{view.body}</p>
          ) : null}

          {view.kind === "checklist" ? (
            <>
              <ol className="mt-4">
                {view.steps.map((step, index) => (
                  <li
                    key={step.id}
                    className="flex items-center gap-3.5 border-b border-[#ececec] py-3.5"
                  >
                    <span
                      className={
                        "grid h-7 w-7 shrink-0 place-items-center rounded-full border-2 border-[#111] text-[13px] font-bold " +
                        (step.done ? "border-accent bg-accent" : "")
                      }
                    >
                      {step.done ? "✓" : index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <b className={step.done ? "text-[#777] line-through" : ""}>
                        {step.optional ? `(Opcional) ${step.title}` : step.title}
                      </b>
                      <small className="block text-[13px] text-[#555]">{step.detail}</small>
                    </div>
                    {step.done ? null : (
                      <Link href={step.href} className={outline}>
                        Empezar
                      </Link>
                    )}
                  </li>
                ))}
              </ol>
              <DismissChecklistButton />
            </>
          ) : null}

          {view.kind !== "blocked" && view.followUp === "due" && progress.followUpHotel ? (
            <div className="mt-6 grid items-center gap-2 rounded-md border border-[#111] p-4 sm:grid-cols-[auto_1fr_auto]">
              <span className="rounded bg-[#fff1e6] px-2 py-0.5 text-xs font-bold text-[#b4400b]">
                Seguimiento
              </span>
              <div>
                <b>Seguimiento a {progress.followUpHotel.name}</b>
                <small className="block text-[13px] text-[#555]">
                  El silencio no es ghosting. Abrí el ciclo y confirmá el estado.
                </small>
              </div>
              <Link
                href={hotelHref(progress.followUpHotel.hotelId, { kind: "pipeline" }) ?? "/app/pipeline"}
                className={primary}
              >
                Abrir ciclo
              </Link>
            </div>
          ) : null}

          {view.kind !== "blocked" && view.followUp === "error" ? (
            <p className="mt-6 text-sm text-muted">
              No pudimos revisar seguimientos. Esto no es “no hay nada pendiente”.
            </p>
          ) : null}
        </section>

        <aside>
          <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#666]">
            Tu progreso (solo tus datos)
          </p>
          {counts.status === "ok" ? (
            <div className="mt-3 grid grid-cols-2 border-t-2 border-[#111]">
              {[
                [counts.counts.outreach, "pitches enviados"],
                [counts.counts.replies, "respuestas"],
                [counts.counts.agreements, "acuerdos"],
                [counts.counts.completedCollaborations, "colaboraciones hechas"],
              ].map(([value, label]) => (
                <div key={String(label)} className="border-b border-[#e6e6e6] py-4">
                  <strong className="block text-4xl font-extrabold tracking-tight">{value}</strong>
                  <span className="text-[13px] text-[#555]">{label}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">
              {counts.status === "not_found"
                ? "No hay un perfil para contar. Esto no es cero."
                : "No pudimos cargar tus conteos. Esto no es cero."}
            </p>
          )}

          {recommended.length > 0 ? (
            <div className="mt-8">
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#666]">
                Descubrimiento recomendado
              </p>
              {recommended.map((hotel) => (
                <Link key={hotel.id} href={`/app/hotels/${hotel.id}`} className="mt-3 flex gap-3.5">
                  <span className="h-16 w-24 shrink-0 rounded bg-[#f3f3f3]" aria-hidden="true" />
                  <span>
                    <b>{hotel.name}</b>
                    <small className="block text-[13px] text-[#555]">{hotel.line}</small>
                  </span>
                </Link>
              ))}
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
