/**
 * F1 — a creator's calendar day is not UTC midnight.
 *
 * `<input type="date">` gives a calendar DAY with no zone. Resolving it at UTC
 * midnight is wrong everywhere east of Greenwich: for a creator at UTC+14 just
 * after midnight, UTC midnight of their local "today" is still hours in the
 * FUTURE, so migration 0020 rightly refuses the pitch they actually sent today.
 *
 * The conversion therefore happens in the browser, where the platform knows the
 * creator's zone and its DST rules for the selected date. These tests drive the
 * real helper with the process timezone standing in for the browser's.
 */
import { afterEach, describe, expect, it } from "vitest";

import { localDateToIso, parseEventInstant, parseWorkflowForm } from "@/lib/pipeline/input";

const ITEM = "11111111-1111-1111-1111-111111111111";
const ORIGINAL_TZ = process.env.TZ;

/** Run `fn` as if the browser were in `tz`. */
function inZone<T>(tz: string, fn: () => T): T {
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = ORIGINAL_TZ;
  }
}

/** What the DB's future check does: is this instant after now (plus slack)? */
function isFuture(iso: string, slackMinutes = 5): boolean {
  return new Date(iso).getTime() > Date.now() + slackMinutes * 60_000;
}

/** The local calendar day the browser would default to in `tz`. */
function localToday(tz: string): string {
  return inZone(tz, () => {
    const now = new Date();
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
  });
}

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe("far-eastern zones: local today is never in the future", () => {
  // UTC+14 and UTC+13: the zones where UTC midnight of "today" is worst.
  for (const tz of ["Pacific/Kiritimati", "Pacific/Apia", "Pacific/Auckland"]) {
    it(`${tz} — today resolves to a past instant`, () => {
      const today = localToday(tz);
      const iso = inZone(tz, () => localDateToIso(today));

      expect(iso).not.toBeNull();
      expect(isFuture(iso!)).toBe(false);

      // The old behaviour, kept here as the thing that must NOT happen again.
      const utcMidnight = `${today}T00:00:00.000Z`;
      if (isFuture(utcMidnight)) {
        expect(new Date(iso!).getTime()).toBeLessThan(new Date(utcMidnight).getTime());
      }
    });
  }

  it("UTC+14 just after local midnight lands on the PREVIOUS UTC calendar day", () => {
    // 2026-08-13 in Kiritimati (UTC+14) begins at 2026-08-12T10:00Z.
    const iso = inZone("Pacific/Kiritimati", () => localDateToIso("2026-08-13"));
    expect(iso).toBe("2026-08-12T10:00:00.000Z");
    expect(iso!.slice(0, 10)).toBe("2026-08-12");
  });
});

describe("western zones", () => {
  it("UTC-10 and UTC-11 resolve today to a past instant on the same or later UTC day", () => {
    for (const tz of ["Pacific/Honolulu", "Pacific/Midway", "America/Anchorage"]) {
      const today = localToday(tz);
      const iso = inZone(tz, () => localDateToIso(today));
      expect(iso).not.toBeNull();
      expect(isFuture(iso!)).toBe(false);
    }
  });

  it("UTC-11 midnight is the same calendar day at 11:00 UTC", () => {
    expect(inZone("Pacific/Midway", () => localDateToIso("2026-08-13"))).toBe(
      "2026-08-13T11:00:00.000Z",
    );
  });
});

describe("DST is handled by the platform, not by hand", () => {
  it("the same zone yields different offsets inside and outside DST", () => {
    const summer = inZone("America/New_York", () => localDateToIso("2026-07-01"));
    const winter = inZone("America/New_York", () => localDateToIso("2026-01-01"));
    expect(summer).toBe("2026-07-01T04:00:00.000Z"); // EDT, UTC-4
    expect(winter).toBe("2026-01-01T05:00:00.000Z"); // EST, UTC-5
  });

  it("preserves the intended local calendar day across a DST boundary", () => {
    for (const date of ["2026-03-07", "2026-03-08", "2026-03-09", "2026-11-01", "2026-11-02"]) {
      const iso = inZone("America/New_York", () => localDateToIso(date))!;
      const backLocal = inZone("America/New_York", () => {
        const d = new Date(iso);
        return [
          d.getFullYear(),
          String(d.getMonth() + 1).padStart(2, "0"),
          String(d.getDate()).padStart(2, "0"),
        ].join("-");
      });
      expect(backLocal).toBe(date);
    }
  });

  it("a spring-forward date with no local midnight still resolves to that day", () => {
    // 2026-09-06 in Santiago: clocks jump 00:00 → 01:00.
    const iso = inZone("America/Santiago", () => localDateToIso("2026-09-06"));
    expect(iso).not.toBeNull();
    const backLocal = inZone("America/Santiago", () => new Date(iso!).getDate());
    expect(backLocal).toBe(6);
  });
});

describe("historical backfill", () => {
  it("keeps an old date's own offset rather than today's", () => {
    // Europe/Madrid: CET in winter (UTC+1), CEST in summer (UTC+2).
    expect(inZone("Europe/Madrid", () => localDateToIso("2024-01-15"))).toBe(
      "2024-01-14T23:00:00.000Z",
    );
    expect(inZone("Europe/Madrid", () => localDateToIso("2024-07-15"))).toBe(
      "2024-07-14T22:00:00.000Z",
    );
  });
});

describe("rejections survive the change", () => {
  it("rejects impossible and malformed days in every zone", () => {
    for (const tz of ["UTC", "Pacific/Kiritimati", "America/Anchorage"]) {
      for (const bad of [
        null,
        undefined,
        "",
        "2026-02-31",
        "2026-13-01",
        "2026-00-10",
        "13/08/2026",
        "2026-8-1",
        "yesterday",
        "2026-08-13T00:00:00Z",
      ]) {
        expect(inZone(tz, () => localDateToIso(bad))).toBeNull();
      }
    }
  });

  it("an explicitly future local day still resolves to a future instant, for the DB to reject", () => {
    const nextYear = new Date(Date.now() + 400 * 86_400_000);
    const date = [
      nextYear.getFullYear(),
      String(nextYear.getMonth() + 1).padStart(2, "0"),
      String(nextYear.getDate()).padStart(2, "0"),
    ].join("-");

    for (const tz of ["Pacific/Kiritimati", "UTC", "Pacific/Midway"]) {
      const iso = inZone(tz, () => localDateToIso(date))!;
      // The app does not pre-judge this; it hands the DB an instant the DB
      // will refuse with invalid_event_time.
      expect(isFuture(iso)).toBe(true);
    }
  });
});

describe("the parsed form carries the converted instant", () => {
  it("round-trips a browser conversion through the form parser", () => {
    const iso = inZone("Pacific/Auckland", () => localDateToIso("2026-08-13"))!;
    expect(parseEventInstant(iso)).toBe(iso);

    const parsed = parseWorkflowForm({
      pipelineItemId: ITEM,
      action: "mark_pitched",
      eventAt: iso,
      channel: "email",
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.eventAt).toBe(iso);
  });

  it("a form that somehow posts a bare calendar day is rejected, not guessed", () => {
    const parsed = parseWorkflowForm({
      pipelineItemId: ITEM,
      action: "mark_pitched",
      eventAt: "2026-08-13",
      channel: "email",
    });
    expect(parsed.ok).toBe(false);
  });
});
