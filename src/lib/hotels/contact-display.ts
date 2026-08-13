/**
 * Pure display helpers for hotel contacts (PRD §7.3).
 *
 * Generic mailboxes legitimately have no person attached. In that case we label
 * the contact by its actual department/role — we NEVER invent or infer a
 * person's name (HOTEL_DATA_CONTRACT §4).
 */

/** Human label for the canonical `hotel_contacts.department` vocabulary. */
export function departmentLabel(department: string | null): string | null {
  if (!department) return null;
  switch (department) {
    case "pr":
      return "PR";
    case "social_media":
      return "Social media";
    case "communications":
      return "Communications";
    case "reservations":
      return "Reservations";
    case "partnerships":
      return "Partnerships";
    case "marketing":
      return "Marketing";
    case "events":
      return "Events";
    case "sales":
      return "Sales";
    case "general":
      return "General";
    case "other":
    case "unknown":
      return null;
    default:
      return department.charAt(0).toUpperCase() + department.slice(1).replace(/_/g, " ");
  }
}

/**
 * The heading shown for a contact. Prefers the researched display name; falls
 * back to the job title, then to a department-derived role label, and finally
 * to a neutral "General contact". Never fabricates a personal name.
 */
export function contactDisplayLabel(contact: {
  displayName: string | null;
  jobTitle: string | null;
  department: string | null;
}): string {
  const name = contact.displayName?.trim();
  if (name) return name;

  const title = contact.jobTitle?.trim();
  if (title) return title;

  const dept = departmentLabel(contact.department);
  if (dept) return `${dept} contact`;

  return "General contact";
}

/** True when the heading is a role label rather than a researched person. */
export function isGenericContact(contact: { displayName: string | null }): boolean {
  return !contact.displayName?.trim();
}

/** Format a verification date for display; returns null when absent/invalid. */
export function formatVerifiedAt(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/** Human label for `hotel_contacts.verification_status`. */
export function contactVerificationLabel(status: string | null): string {
  switch (status) {
    case "verified":
      return "Verified contact";
    case "probable":
      return "Probable contact";
    case "inferred":
      return "Inferred contact";
    case "invalid":
      return "Invalid contact";
    default:
      return "Unverified contact";
  }
}
