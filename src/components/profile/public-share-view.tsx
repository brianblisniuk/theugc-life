import type { PublicPortfolio, PublicShareView } from "@/lib/profile/share-contract";

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} rel="noreferrer noopener" className="text-text underline">
      {children}
    </a>
  );
}

/**
 * Read-only hotel view. Renders only the sections the mapper kept.
 * Unknown is the word Unknown. It is never a zero.
 */
export function PublicShareView({ view }: { view: PublicShareView }) {
  const empty =
    view.bio === undefined &&
    view.niche === undefined &&
    view.socialLinks === undefined &&
    view.audience === undefined &&
    view.collaborations === undefined &&
    view.examples === undefined &&
    view.portfolio === undefined;

  return (
    <article className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-text">Creator profile</h1>
        <p className="max-w-prose text-sm text-muted">
          Shared by the creator. Only the fields they turned on are shown.
        </p>
      </header>

      {empty ? (
        <p className="max-w-prose text-sm text-muted">
          This creator hasn’t shared any details on this link.
        </p>
      ) : null}

      {view.bio !== undefined ? (
        <section className="space-y-1">
          <h2 className="text-lg font-semibold text-text">Bio</h2>
          <p className="max-w-prose text-sm text-text">{view.bio}</p>
        </section>
      ) : null}

      {view.niche !== undefined ? (
        <section className="space-y-1">
          <h2 className="text-lg font-semibold text-text">Niche</h2>
          <p className="text-sm text-text">{view.niche}</p>
        </section>
      ) : null}

      {view.socialLinks ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-text">Social links</h2>
          <ul className="space-y-1 text-sm">
            {view.socialLinks.map((link) => (
              <li key={link.label}>
                <span className="text-muted">{link.label}: </span>
                {link.href ? (
                  <ExternalLink href={link.href}>{link.text}</ExternalLink>
                ) : (
                  <span>{link.text}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.audience ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-text">Audience</h2>
          <p className="text-xs font-medium text-muted">Self-reported. Not verified.</p>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-[var(--radius-app)] border border-border bg-surface p-4">
              <dt className="text-xs font-medium text-muted">Followers</dt>
              <dd className="mt-1 text-base text-text">{view.audience.followers}</dd>
            </div>
            <div className="rounded-[var(--radius-app)] border border-border bg-surface p-4">
              <dt className="text-xs font-medium text-muted">Engagement</dt>
              <dd className="mt-1 text-base text-text">{view.audience.engagement}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      {view.collaborations ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-text">Past collaborations</h2>
          {view.collaborations.length === 0 ? (
            <p className="text-sm text-muted">None shared.</p>
          ) : (
            <ul className="space-y-3">
              {view.collaborations.map((item) => (
                <li
                  key={`${item.hotelName}-${item.when}-${item.status}`}
                  className="space-y-1 rounded-[var(--radius-app)] border border-border bg-surface p-4"
                >
                  <h3 className="text-base font-semibold text-text">{item.hotelName}</h3>
                  <p className="text-sm text-muted">
                    {item.status}
                    {item.typeLabel ? ` · ${item.typeLabel}` : ""}
                  </p>
                  <p className="text-xs text-muted">{item.when}</p>
                  {item.compensation !== null ? (
                    <p className="text-sm text-text">Compensation: {item.compensation}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {view.portfolio ? <PortfolioSection portfolio={view.portfolio} /> : null}

      {view.examples ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-text">Content examples</h2>
          {view.examples.length === 0 ? (
            <p className="text-sm text-muted">None shared.</p>
          ) : (
            <ul className="space-y-3">
              {view.examples.map((item) => (
                <li key={item.href} className="space-y-1">
                  <p className="text-sm text-text">
                    {item.label}
                    <span className="text-muted"> · {item.platform}</span>
                  </p>
                  <ExternalLink href={item.href}>{item.href}</ExternalLink>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </article>
  );
}

function PortfolioSection({ portfolio }: { portfolio: PublicPortfolio }) {
  const heading =
    portfolio.template === "destinations"
      ? "Portfolio by destination"
      : portfolio.template === "highlights"
        ? "Portfolio highlights"
        : "Portfolio journey";

  if (portfolio.template === "journey") {
    return (
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-text">{heading}</h2>
        <ol className="space-y-3">
          {portfolio.entries.map((entry) => (
            <li
              key={`${entry.hotelName}-${entry.when}-${entry.status}`}
              className="space-y-1 rounded-[var(--radius-app)] border border-border bg-surface p-4"
            >
              <p className="text-xs font-medium text-muted">{entry.when}</p>
              <h3 className="text-base font-semibold text-text">{entry.hotelName}</h3>
              <p className="text-sm text-muted">
                {entry.destination} · {entry.status}
                {entry.typeLabel ? ` · ${entry.typeLabel}` : ""}
              </p>
            </li>
          ))}
        </ol>
      </section>
    );
  }

  if (portfolio.template === "destinations") {
    const groups: { destination: string; entries: PublicPortfolio["entries"] }[] = [];
    for (const entry of portfolio.entries) {
      const last = groups[groups.length - 1];
      if (last && last.destination === entry.destination) last.entries.push(entry);
      else groups.push({ destination: entry.destination, entries: [entry] });
    }
    return (
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text">{heading}</h2>
        {groups.map((group) => (
          <div key={group.destination} className="space-y-2">
            <h3 className="text-base font-semibold text-text">{group.destination}</h3>
            <ul className="space-y-2">
              {group.entries.map((entry) => (
                <li key={`${entry.hotelName}-${entry.when}`} className="text-sm text-text">
                  {entry.hotelName}
                  <span className="text-muted">
                    {" "}
                    · {entry.status} · {entry.when}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-text">{heading}</h2>
      <ul className="space-y-3">
        {portfolio.entries.map((entry) => (
          <li
            key={`${entry.hotelName}-${entry.when}-${entry.status}`}
            className="space-y-1 rounded-[var(--radius-app)] border border-border bg-surface p-4"
          >
            <h3 className="text-xl font-semibold text-text">{entry.hotelName}</h3>
            <p className="text-sm text-muted">
              {entry.destination} · {entry.status}
              {entry.typeLabel ? ` · ${entry.typeLabel}` : ""}
            </p>
            <p className="text-xs text-muted">{entry.when}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
