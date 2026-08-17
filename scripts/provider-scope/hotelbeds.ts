/**
 * Hotelbeds hospitality-scope policy v1.
 *
 * Read on `accommodationTypeCode`, resolved through the 24-code accommodations
 * master retrieved to exhaustion in PR #21
 * (`.data/provider-evaluation/hotelbeds-accommodation-types.json`,
 * `exhaustionProven: true`). Every one of the 24 codes is accounted for below —
 * mapped or deliberately left out — and the reasoning, code by code, is
 * `docs/PROPERTY_SOURCE_HOSPITALITY_SCOPE_POLICY.md`.
 *
 * THE LINE THIS POLICY DRAWS
 * --------------------------
 * A code is mapped to `physical_hospitality` when the provider's own master
 * wording names an ACCOMMODATION BUSINESS — a place operated to host guests —
 * rather than a DWELLING that may happen to be let, or a VEHICLE.
 *
 * That distinction is the whole point. "Apartment" proves a unit is
 * accommodation; it does not prove there is a hospitality OPERATION behind it,
 * and this provider's master does not settle the difference. So those codes stay
 * `unresolved`, which means REVIEW — never `not_physical_hospitality`.
 *
 * WHAT IS NOT IN HERE
 * -------------------
 * No star reasoning. `S` Hostel is mapped `physical_hospitality` even though a
 * hostel will rarely carry an approved 4/5 classification, because D060 says
 * type alone is not the eligibility gate and the two dimensions are resolved
 * independently. Nothing here reads a name, a rating, a price, a chain, a
 * website or a photo.
 */
import type { HospitalityScopePolicy } from "./policy";

export const HOTELBEDS_HOSPITALITY_SCOPE_POLICY: HospitalityScopePolicy = {
  provider: "hotelbeds",
  version: "hotelbeds-hospitality-scope/1",
  field: "accommodationTypeCode",
  notes:
    "Reviewed against the 24-code accommodations master retrieved to exhaustion in PR #21 and " +
    "the live Bali/Dubai type distributions. Mapped to physical_hospitality only where the " +
    "master names an operated accommodation business; the 'Vacation *' family and the bare " +
    "dwelling labels stay unresolved because the master does not establish that a unit is a " +
    "hospitality operation. See docs/PROPERTY_SOURCE_HOSPITALITY_SCOPE_POLICY.md.",
  mappings: {
    // ---- PHYSICAL HOSPITALITY: the master names an operated establishment ----
    // Each of these is a plain-English establishment noun in the provider's own
    // register, or contains one.
    H: "physical_hospitality", // Hotel
    W: "physical_hospitality", // Resort
    P: "physical_hospitality", // Aparthotel — named by D060 ("aparthotel / hotel apartment")
    G: "physical_hospitality", // Guest house
    K: "physical_hospitality", // Bed and breakfast
    // Mapped despite the product's 4/5 focus. Type and star eligibility are
    // independent dimensions (D060); excluding a hostel HERE would smuggle a
    // classification judgement into the type resolver.
    S: "physical_hospitality", // Hostel
    M: "physical_hospitality", // Motel
    D: "physical_hospitality", // Lodge — named by D060
    Z: "physical_hospitality", // Rural hotel
    X: "physical_hospitality", // Historical hotel Luxurious
    // "Boutique" is a bare adjective, and is mapped only because D060 itself
    // names "boutique hotel" as a qualifying physical hospitality form — the
    // evidence is in this repository, not inferred from the word.
    Q: "physical_hospitality", // Boutique

    // ---- NOT PHYSICAL HOSPITALITY: not a fixed property at all --------------
    // The only two codes the master settles negatively. Both name a vessel or an
    // itinerary rather than a property, so no reading of D060 admits them.
    U: "not_physical_hospitality", // Cruise
    L: "not_physical_hospitality", // Boat

    // ---- Everything else is ABSENT, and therefore `unresolved` -------------
    // Listed here as documentation of what was considered and refused; the
    // lookup treats an absent code as unresolved, so these are the reasoning,
    // not the mechanism:
    //
    //   A  Apartment                    a dwelling, not evidently an operation
    //   V  Vacation home or villa       same
    //   C  Vacation condo or apartment  same
    //   T  Vacation Townhouse           same
    //   R  Vacation resort              the master's "Vacation *" prefix marks a
    //                                   distinct register; "resort" inside it
    //                                   does not clearly mean an operated resort
    //   Y  Rural house                  a dwelling
    //   N  Residence                    D060 allows a "residence" form, but the
    //                                   bare label does not distinguish a
    //                                   serviced residence from a residential
    //                                   building. FIRST CANDIDATE FOR v2.
    //   B  Botel                        a floating hotel: an operation, but not
    //                                   evidently a fixed physical property
    //   E  Camping                      an operated site rather than a property
    //   I  Riad                         a building style that is usually, but not
    //                                   provably, an operated guesthouse
    //   O  Pousada                      a loanword for an inn; not established
    //                                   for this provider by the master alone
  },
};
