import "server-only";

/**
 * Contact provider boundary (D100).
 *
 * Only the fake provider is wired. Any other CONTACT_PROVIDER value refuses
 * to start. This module does not call a network, a vendor, or a payment API.
 */

export interface ContactLookup {
  hotelId: string;
  name: string;
  domain: string | null;
}

export interface ContactLookupResult {
  status: "found" | "not_found";
  email: string | null;
  raw: { provider: "fake"; status: "found" | "not_found" };
}

export interface ContactProvider {
  findHotelEmail(input: ContactLookup): Promise<ContactLookupResult>;
}

const FAKE = "fake";

/** Unset means fake. Anything else is not approved. */
export function contactProviderName(raw: string | undefined): typeof FAKE {
  const value = raw === undefined ? FAKE : raw.trim();
  if (value === "" || value === FAKE) return FAKE;
  throw new Error("CONTACT_PROVIDER is not approved. Only the fake provider is wired.");
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
  assertContactProvider();
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
