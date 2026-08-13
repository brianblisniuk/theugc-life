/**
 * Premium contact card (PRD §7.3, PERMISSIONS.md §7).
 *
 * Rendered ONLY for a caller the database has already authorized. The parent
 * never fetches these values otherwise, so there is nothing here to hide or
 * blur — an unauthorized user's page simply has no contact data in it.
 *
 * `source_reference` is intentionally not displayed: it is internal research
 * provenance, not creator-facing product data.
 */
import {
  contactDisplayLabel,
  contactVerificationLabel,
  departmentLabel,
  formatVerifiedAt,
  isGenericContact,
} from "@/lib/hotels/contact-display";
import type { HotelContact } from "@/lib/hotels/queries";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="break-all text-text">{children}</dd>
    </div>
  );
}

export function ContactCard({ contact }: { contact: HotelContact }) {
  const heading = contactDisplayLabel(contact);
  const dept = departmentLabel(contact.department);
  const verifiedAt = formatVerifiedAt(contact.verifiedAt);

  return (
    <article className="space-y-3 rounded-[var(--radius-app)] border border-border bg-surface p-4">
      <header className="space-y-1">
        <h3 className="text-base font-semibold text-text">{heading}</h3>
        {isGenericContact(contact) ? (
          <p className="text-xs text-muted">Role-based mailbox — no named individual on file.</p>
        ) : contact.jobTitle ? (
          <p className="text-sm text-muted">{contact.jobTitle}</p>
        ) : null}
        {contact.organizationName ? (
          <p className="text-sm text-muted">{contact.organizationName}</p>
        ) : null}
      </header>

      <dl className="space-y-1.5">
        {dept ? <Row label="Department">{dept}</Row> : null}
        {contact.email ? (
          <Row label="Email">
            <a className="underline hover:no-underline" href={`mailto:${contact.email}`}>
              {contact.email}
            </a>
          </Row>
        ) : null}
        {contact.phone ? (
          <Row label="Phone">
            <a className="underline hover:no-underline" href={`tel:${contact.phone}`}>
              {contact.phone}
            </a>
          </Row>
        ) : null}
        {contact.linkedinUrl ? (
          <Row label="LinkedIn">
            <a
              className="underline hover:no-underline"
              href={contact.linkedinUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              {`LinkedIn profile for ${heading}`}
            </a>
          </Row>
        ) : null}
      </dl>

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span>{contactVerificationLabel(contact.verificationStatus)}</span>
        {verifiedAt ? <span>Last verified {verifiedAt}</span> : null}
      </footer>
    </article>
  );
}
