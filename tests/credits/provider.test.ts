/**
 * Unset or fake stays the local provider. hunter is the only other approved
 * name. The fake result is deterministic and does not use the network.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  contactProviderName,
  domainFromWebsite,
  fakeHotelEmail,
  getContactProvider,
} from "@/lib/contacts/provider";

const HOTEL = "22222222-2222-4222-8222-222222222222";

describe("fake contact provider", () => {
  const previous = process.env.CONTACT_PROVIDER;

  afterEach(() => {
    if (previous === undefined) delete process.env.CONTACT_PROVIDER;
    else process.env.CONTACT_PROVIDER = previous;
  });

  it("treats an unset or blank name as fake and rejects anything else", () => {
    delete process.env.CONTACT_PROVIDER;
    expect(contactProviderName(process.env.CONTACT_PROVIDER)).toBe("fake");
    expect(contactProviderName("")).toBe("fake");
    expect(contactProviderName("  fake  ")).toBe("fake");
    expect(() => contactProviderName("apollo")).toThrow(/not approved/);
  });

  it("returns a stable address and never a network call", async () => {
    delete process.env.CONTACT_PROVIDER;
    const found = fakeHotelEmail({ hotelId: HOTEL, name: "E2E Harbor House", domain: null });
    expect(found).toEqual({
      status: "found",
      email: "found-222222222222@fake-provider.test",
      raw: { provider: "fake", status: "found" },
    });
    expect(
      fakeHotelEmail({ hotelId: HOTEL, name: "NoContact Inn", domain: "example.test" }).status,
    ).toBe("not_found");
    expect(
      fakeHotelEmail({ hotelId: HOTEL, name: "Harbor", domain: "not-found.invalid" }).email,
    ).toBeNull();
    const provider = getContactProvider();
    await expect(
      provider.findHotelEmail({ hotelId: HOTEL, name: "E2E Harbor House", domain: null }),
    ).resolves.toEqual(found);
    expect(domainFromWebsite("https://hotel.example/path")).toBe("hotel.example");
    expect(domainFromWebsite("not a url")).toBeNull();
  });
});
