import { UnlockContact } from "@/components/contacts/unlock-contact";
import { ReportContact } from "@/components/contacts/report-contact";
import { ContactCard } from "@/components/hotels/contact-card";
import {
  contactVerificationLabel,
  formatVerifiedAt,
  isGenericContact,
} from "@/lib/hotels/contact-display";
import type { HotelContact } from "@/lib/hotels/queries";
import {
  CONTACT_ERROR_BODY,
  CONTACT_ERROR_TITLE,
  NO_CONTACT_TITLE,
  UNLOCK_ASSURANCE,
} from "@/lib/screens/copy";
import type { ContactSectionState } from "@/lib/hotels/access";

function LockedSkeleton() {
  return (
    <div
      className="s1-skel"
      aria-label="Placeholder contact fields. No personal data is on this page."
    >
      <div className="s1-skel-row">
        <span>Name and role</span>
        <i className="s1-skel-line" style={{ flex: 1 }} />
      </div>
      <div className="s1-skel-row">
        <span>Professional email</span>
        <i className="s1-skel-line" style={{ flex: 1 }} />
      </div>
      <div className="s1-skel-row">
        <span>Contact verification</span>
        <i className="s1-skel-line" style={{ flex: 1 }} />
      </div>
    </div>
  );
}

function freshness(contact: HotelContact): string {
  const verifiedAt = formatVerifiedAt(contact.verifiedAt);
  const label = contactVerificationLabel(contact.verificationStatus);
  return verifiedAt ? `${label} · Last verified ${verifiedAt}` : label;
}

export function ContactFeature({
  hotelId,
  state,
  contacts,
  cacheEmail,
  via,
  balance,
  cost,
}: {
  hotelId: string;
  state: ContactSectionState;
  contacts: readonly HotelContact[];
  cacheEmail: string | null;
  via: "unlock" | "staff" | "none";
  balance: number | null;
  cost: number;
}) {
  const named = contacts.some((contact) => !isGenericContact(contact));
  return (
    <section className="s1-contact" id="contact" aria-label="Hotel contact">
      <div className="s1-contact-head">
        <span className="s1-square" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
          </svg>
        </span>
        <div>
          <strong>Reach the right hotel contact</strong>
          <p className="s1-muted">Decision-maker or responsible department</p>
        </div>
      </div>

      {state === "locked" ? (
        <>
          <LockedSkeleton />
          <div style={{ marginTop: 12 }}>
            <UnlockContact
              hotelId={hotelId}
              unlocked={false}
              balance={balance}
              cost={cost}
              showEmail
            />
          </div>
          <p className="s1-muted">{UNLOCK_ASSURANCE} One credit per hotel, not per person. Reopening this hotel costs zero.</p>
        </>
      ) : null}

      {state === "contacts" ? (
        <div className="ux-stack">
          {via === "unlock" ? <p className="s1-metric-name">Already unlocked</p> : null}
          {contacts.map((contact) => (
            <div key={contact.id}>
              <ContactCard contact={contact} />
              <p className="s1-metric-note">{freshness(contact)}</p>
              {isGenericContact(contact) ? (
                <p className="s1-metric-note">Department inbox. No named person on file.</p>
              ) : null}
            </div>
          ))}
          {contacts.length === 0 && cacheEmail ? (
            <p>
              <a href={`mailto:${cacheEmail}`}>{cacheEmail}</a>
            </p>
          ) : null}
          <p className="s1-muted">
            {named ? "Named contact on file." : "No named person on file."} A second look at this
            hotel does not spend another credit.
          </p>
          {via === "unlock" ? <ReportContact hotelId={hotelId} /> : null}
        </div>
      ) : null}

      {state === "empty" ? (
        <div role="status">
          {via === "unlock" ? <p className="s1-metric-name">Already unlocked</p> : null}
          <h2>{NO_CONTACT_TITLE}</h2>
          <p className="s1-muted">
            {via === "unlock"
              ? "This unlock did not return an email. Reporting it is how a courtesy credit starts. It did not spend a second credit."
              : "No published contact for this hotel yet."}
          </p>
          {via === "unlock" ? <ReportContact hotelId={hotelId} /> : null}
        </div>
      ) : null}

      {state === "access-error" ? (
        <div className="v12-state" role="status">
          <h2>Contact access couldn’t be checked</h2>
          <p>Reload to try again. This is not a plan lock.</p>
        </div>
      ) : null}

      {state === "fetch-error" ? (
        <div className="v12-state v12-state-danger" role="alert">
          <h2>{CONTACT_ERROR_TITLE}</h2>
          <p>{CONTACT_ERROR_BODY}</p>
          <a className="v12-btn" href="">
            Retry
          </a>
        </div>
      ) : null}

    </section>
  );
}
