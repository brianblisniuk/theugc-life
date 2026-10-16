import "server-only";

/**
 * Contact provider boundary (D100, D180).
 *
 * Unset, blank, or `fake` is the local and CI provider. It does not use the
 * network. `hunter` is the Hunter adapter. Any other CONTACT_PROVIDER value
 * refuses to start. The Hunter key is read only inside the Hunter adapter.
 */

import { createHunterProvider } from "./hunter.server";
import type { ContactLookup, ContactLookupResult, ContactProvider } from "./types";

export type { ContactLookup, ContactLookupResult, ContactProvider } from "./types";
export { unlockFollowUp } from "./types";

const FAKE = "fake";
const HUNTER = "hunter";

export type ContactProviderName = typeof FAKE | typeof HUNTER;

/** Unset means fake. hunter is the approved network provider. */
export function contactProviderName(raw: string | undefined): ContactProviderName {
  const value = (raw === undefined ? FAKE : raw).trim().toLowerCase();
  if (value === "" || value === FAKE) return FAKE;
  if (value === HUNTER) return HUNTER;
  throw new Error("CONTACT_PROVIDER is not approved. Approved providers are fake and hunter.");
}

export function assertContactProvider(): void {
  contactProviderName(process.env.CONTACT_PROVIDER);
}

export function fakeHotelEmail(input: ContactLookup): ContactLookupResult {
  const name = input.name.trim().toLowerCase();
  const domain = input.domain?.trim().toLowerCase() ?? "";
  if (name.includes("nocontact") || domain === "not-found.invalid") {
    return { status: "not_found", email: null, raw: { provider: "fake", status: "not_found" } };
  }
  const local = input.hotelId.replace(/-/g, "").slice(0, 12);
  return {
    status: "found",
    email: `found-${local}@fake-provider.test`,
    raw: { provider: "fake", status: "found" },
  };
}

class FakeContactProvider implements ContactProvider {
  findHotelEmail(input: ContactLookup): Promise<ContactLookupResult> {
    return Promise.resolve(fakeHotelEmail(input));
  }
}

export function getContactProvider(): ContactProvider {
  const name = contactProviderName(process.env.CONTACT_PROVIDER);
  if (name === HUNTER) return createHunterProvider();
  return new FakeContactProvider();
}

/** Host of a website URL, or null. Never fetches the URL. */
export function domainFromWebsite(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(website) ? website : `https://${website}`;
    const host = new URL(withScheme).hostname.trim().toLowerCase();
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}
