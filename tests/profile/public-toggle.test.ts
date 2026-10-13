/**
 * D096. The toggle shows the stored flag. A successful save must not invert
 * the prop that revalidatePath already refreshed.
 */
import { describe, expect, it } from "vitest";

import { publicProfileIsOn, type PublicProfileToggleState } from "@/lib/profile/public-toggle";

describe("publicProfileIsOn", () => {
  it("does not invert the refreshed prop after a successful save", () => {
    expect(publicProfileIsOn(true, { result: "saved", enabled: true })).toBe(true);
    expect(publicProfileIsOn(false, { result: "saved", enabled: false })).toBe(false);
  });

  it("uses the stored flag until the server prop catches up", () => {
    expect(publicProfileIsOn(false, { result: "saved", enabled: true })).toBe(true);
    expect(publicProfileIsOn(true, { result: "saved", enabled: false })).toBe(false);
  });

  it("uses the server prop when there is no save and after an error", () => {
    expect(publicProfileIsOn(false, null)).toBe(false);
    expect(publicProfileIsOn(true, null)).toBe(true);
    expect(publicProfileIsOn(false, { result: "error" })).toBe(false);
    expect(publicProfileIsOn(true, { result: "error" })).toBe(true);
  });

  it("follows public, private, and public again, including a late older refresh", () => {
    let server = false;
    let state: PublicProfileToggleState = null;
    expect(publicProfileIsOn(server, state)).toBe(false);

    state = { result: "saved", enabled: true };
    expect(publicProfileIsOn(server, state)).toBe(true);
    server = true;
    expect(publicProfileIsOn(server, state)).toBe(true);

    state = { result: "saved", enabled: false };
    expect(publicProfileIsOn(server, state)).toBe(false);
    expect(publicProfileIsOn(true, state)).toBe(false);
    server = false;
    expect(publicProfileIsOn(server, state)).toBe(false);

    state = { result: "saved", enabled: true };
    expect(publicProfileIsOn(server, state)).toBe(true);
    expect(publicProfileIsOn(false, state)).toBe(true);
    server = true;
    expect(publicProfileIsOn(server, state)).toBe(true);
  });
});
