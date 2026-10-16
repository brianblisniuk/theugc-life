/**
 * V2-S3 Pitch Studio facts.
 *
 * Dates, recipients, and opportunity choice come from loaded rows. A second
 * opportunity is not absorbed into the first. The draft checklist does not
 * invent a claim the text does not contain.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assignOpportunity,
  chooseOpportunity,
  draftScopeNote,
  portfolioLine,
  PITCH_OPPORTUNITY_CAP,
  closedRowDraft,
  currentDraftWrite,
  mayReplaceSavedDraft,
  mergeNamedOpportunity,
  opportunityDraftTrip,
  opportunityNeedsChoice,
  pitchTripToStore,
  readOpportunityParam,
  resolveOpportunityDraftWrite,
  takeOpportunityPage,
  tripChangeForOpportunity,
  UNTOUCHED_DRAFT_MESSAGE,
  visiblePitchDraft,
  recipientLine,
  reviewChecks,
  selectBoundDraft,
  travelWindow,
  type StudioOpportunity,
} from "@/lib/pitch/studio";

const FIRST: StudioOpportunity = {
  id: "11111111-1111-4111-8111-111111111111",
  displayRef: "OP-1042",
  status: "replied",
  stayStart: "2026-11-12",
  stayEnd: "2026-11-19",
  tripId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

const SECOND: StudioOpportunity = {
  id: "22222222-2222-4222-8222-222222222222",
  displayRef: "OP-1084",
  status: "planned",
  stayStart: null,
  stayEnd: null,
  tripId: null,
};

describe("opportunity choice", () => {
  it("does not pick one when two are open and the URL names neither", () => {
    const choice = chooseOpportunity([FIRST, SECOND], null);
    expect(choice.choice).toBe("many");
    expect(choice.selected).toBeNull();
  });

  it("uses the named opportunity and refuses a foreign id", () => {
    expect(chooseOpportunity([FIRST, SECOND], SECOND.id).selected?.displayRef).toBe("OP-1084");
    expect(chooseOpportunity([FIRST], "33333333-3333-4333-8333-333333333333").choice).toBe(
      "missing",
    );
  });

  it("binds the only open opportunity", () => {
    expect(chooseOpportunity([FIRST], null)).toEqual({ choice: "one", selected: FIRST });
    expect(chooseOpportunity([], null).choice).toBe("none");
  });

  it("uses only the open row on a trip origin, and does not open another trip", () => {
    const otherTrip = "55555555-5555-4555-8555-555555555555";
    expect(chooseOpportunity([FIRST, SECOND], null, FIRST.tripId)).toEqual({
      choice: "one",
      selected: FIRST,
    });
    expect(chooseOpportunity([SECOND], null, FIRST.tripId)).toEqual({
      choice: "trip_empty",
      selected: null,
    });
    expect(chooseOpportunity([FIRST], null, otherTrip)).toEqual({
      choice: "trip_empty",
      selected: null,
    });
    const also = { ...FIRST, id: SECOND.id, displayRef: "OP-1084" };
    const chosen = chooseOpportunity([FIRST, also, SECOND], null, FIRST.tripId);
    expect(chosen.choice).toBe("choose");
    if (chosen.choice === "choose") {
      expect(chosen.opportunities.map((row) => row.id)).toEqual([FIRST.id, also.id]);
    }
    const closed = {
      ...FIRST,
      id: "33333333-3333-4333-8333-333333333333",
      status: "closed",
      displayRef: "OP-2001",
    };
    expect(chooseOpportunity([FIRST, closed], null, FIRST.tripId)).toEqual({
      choice: "one",
      selected: FIRST,
    });
    expect(chooseOpportunity([FIRST, SECOND], null, null).choice).toBe("many");
    expect(chooseOpportunity([SECOND], SECOND.id, FIRST.tripId).choice).toBe("selected");
    expect(opportunityNeedsChoice("choose")).toBe(true);
    expect(opportunityNeedsChoice("many")).toBe(true);
    expect(opportunityNeedsChoice("trip_empty")).toBe(true);
    expect(opportunityNeedsChoice("one")).toBe(false);
    expect(opportunityNeedsChoice("selected")).toBe(false);
  });
});

describe("opportunity trip", () => {
  const originTrip = "55555555-5555-4555-8555-555555555555";

  it("keeps opportunity B's trip when the request names trip A", () => {
    expect(opportunityDraftTrip(FIRST, originTrip)).toBe(FIRST.tripId);
    expect(
      pitchTripToStore({
        opportunity: FIRST,
        requestedTripId: originTrip,
        ownedTripId: FIRST.tripId,
      }),
    ).toEqual({
      ok: false,
      message: "That trip is not this opportunity's trip.",
    });
    expect(
      pitchTripToStore({
        opportunity: FIRST,
        requestedTripId: null,
        ownedTripId: FIRST.tripId,
      }),
    ).toEqual({ ok: true, tripId: FIRST.tripId });
  });

  it("does not adopt a requested trip onto an opportunity that has none", () => {
    expect(opportunityDraftTrip(SECOND, originTrip)).toBeNull();
    expect(
      pitchTripToStore({
        opportunity: SECOND,
        requestedTripId: originTrip,
        ownedTripId: originTrip,
      }),
    ).toEqual({
      ok: false,
      message: "That trip is not this opportunity's trip.",
    });
    expect(
      pitchTripToStore({
        opportunity: SECOND,
        requestedTripId: null,
        ownedTripId: null,
      }),
    ).toEqual({ ok: true, tripId: null });
  });

  it("still stores a requested trip when no opportunity is selected", () => {
    expect(opportunityDraftTrip(null, originTrip)).toBe(originTrip);
    expect(
      pitchTripToStore({
        opportunity: null,
        requestedTripId: originTrip,
        ownedTripId: originTrip,
      }),
    ).toEqual({ ok: true, tripId: originTrip });
    expect(
      pitchTripToStore({
        opportunity: null,
        requestedTripId: originTrip,
        ownedTripId: null,
      }),
    ).toEqual({ ok: false, message: "Choose one of your trips." });
  });
});

describe("visible pitch draft", () => {
  const draft = {
    id: "draft-1",
    subject: "Saved subject",
    body: "Saved body that is not the template",
  };
  const suggestion = { subject: "Template subject", body: "Template body" };

  it("keeps the saved draft when the URL also names a trip", () => {
    expect(
      visiblePitchDraft({ draft, fresh: false, templateRequested: false, suggestion }),
    ).toEqual({ subject: draft.subject, body: draft.body, draftId: draft.id });
  });

  it("hides the draft id when the creator starts over or picks a template", () => {
    expect(
      visiblePitchDraft({ draft, fresh: true, templateRequested: false, suggestion }).draftId,
    ).toBeNull();
    expect(visiblePitchDraft({ draft, fresh: false, templateRequested: true, suggestion })).toEqual(
      { subject: suggestion.subject, body: suggestion.body, draftId: null },
    );
  });
});

describe("pitch opportunity page", () => {
  it("caps the list and still keeps a named row from outside the page", () => {
    const rows = Array.from({ length: PITCH_OPPORTUNITY_CAP + 1 }, (_, index) => ({
      id: `row-${index}`,
    }));
    const page = takeOpportunityPage(rows);
    expect(page.capped).toBe(true);
    expect(page.rows).toHaveLength(PITCH_OPPORTUNITY_CAP);
    expect(page.rows.some((row) => row.id === "row-20")).toBe(false);
    const merged = mergeNamedOpportunity(page.rows, { id: "row-20" });
    expect(merged.some((row) => row.id === "row-20")).toBe(true);
    expect(merged).toHaveLength(PITCH_OPPORTUNITY_CAP + 1);
  });

  it("shows a draft bound to a closed row as that closed row", () => {
    const draft = { id: "draft-closed", pipelineItemId: SECOND.id };
    expect(closedRowDraft(draft, "closed")).toEqual(draft);
    expect(closedRowDraft(draft, "saved")).toBeNull();
    expect(closedRowDraft({ id: "loose", pipelineItemId: null }, "closed")).toBeNull();
  });
});

describe("opportunity query", () => {
  it("honors opportunity and still reads the older item param", () => {
    expect(readOpportunityParam(SECOND.id, FIRST.id)).toBe(SECOND.id);
    expect(readOpportunityParam(null, FIRST.id)).toBe(FIRST.id);
    expect(readOpportunityParam("  ", null)).toBeNull();
    const params = new URLSearchParams("item=old&from=pipeline");
    assignOpportunity(params, SECOND.id);
    expect(params.get("opportunity")).toBe(SECOND.id);
    expect(params.get("item")).toBeNull();
    expect(params.get("from")).toBe("pipeline");
  });
});

describe("draft binding", () => {
  const draftA = { id: "draft-a", pipelineItemId: FIRST.id, body: "A text" };
  const draftB = { id: "draft-b", pipelineItemId: SECOND.id, body: "B text" };
  const unbound = { id: "draft-old", pipelineItemId: null, body: "hotel text" };

  it("never shows or selects another opportunity's draft", () => {
    expect(selectBoundDraft([draftB, draftA, unbound], SECOND.id, "selected")).toEqual(draftB);
    expect(selectBoundDraft([draftA, unbound], SECOND.id, "selected")).toBeNull();
    expect(selectBoundDraft([draftA, draftB, unbound], null, "many")).toBeNull();
    expect(selectBoundDraft([draftA, draftB, unbound], null, "choose")).toBeNull();
    expect(selectBoundDraft([unbound, draftA], null, "none")).toEqual(unbound);
    expect(selectBoundDraft([draftA], FIRST.id, "one")).toEqual(draftA);
    expect(selectBoundDraft([draftB], FIRST.id, "one")).toBeNull();
  });
});

describe("travel window", () => {
  it("keeps opportunity dates off the trip and does not invent either", () => {
    expect(
      travelWindow({
        stayStart: "2026-11-12",
        stayEnd: "2026-11-19",
        tripStart: "2026-12-01",
        tripEnd: "2026-12-08",
      }),
    ).toEqual({ source: "opportunity", label: "2026-11-12 – 2026-11-19" });
    expect(
      travelWindow({
        stayStart: null,
        stayEnd: null,
        tripStart: "2026-12-01",
        tripEnd: "2026-12-08",
      }),
    ).toEqual({ source: "trip", label: "2026-12-01 – 2026-12-08" });
    expect(
      travelWindow({ stayStart: null, stayEnd: null, tripStart: null, tripEnd: null }),
    ).toEqual({ source: "unconfirmed", label: "Not confirmed" });
  });
});

describe("recipient and portfolio", () => {
  it("does not invent a decision maker", () => {
    expect(recipientLine({ email: null, locked: true, unchecked: false })).toBe(
      "Locked. A name is not inferred.",
    );
    expect(recipientLine({ email: null, locked: false, unchecked: true })).toBe(
      "The contact couldn’t be checked. No name is inferred.",
    );
    expect(recipientLine({ email: "ada@hotel.test", locked: false, unchecked: false })).toBe(
      "ada@hotel.test",
    );
    expect(recipientLine({ email: null, locked: false, unchecked: false })).toBe(
      "No unlocked email on this hotel.",
    );
    expect(recipientLine({ email: "ada@hotel.test", locked: false, unchecked: true })).toBe(
      "The contact couldn’t be checked. No name is inferred.",
    );
    expect(portfolioLine(null)).toBe("No portfolio item on this account.");
    expect(portfolioLine("  ")).toBe("No portfolio item on this account.");
    expect(portfolioLine("River film")).toBe("River film");
  });
});

describe("one current draft", () => {
  const OPP = "22222222-2222-4222-8222-222222222222";
  const suggestion = { subject: "Template subject", body: "Template body for this hotel" };
  const savedDraft = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    subject: "Saved subject",
    body: "Saved body",
  };

  type Stored = { id: string; opportunityId: string; body: string };

  function apply(
    rows: Stored[],
    postedDraftId: string | null,
    body: string,
  ): { rows: Stored[]; result: "saved" | "error"; draftId: string | null } {
    const loaded = rows.find((row) => row.opportunityId === OPP) ?? null;
    const write = resolveOpportunityDraftWrite({
      postedDraftId,
      loadedDraftId: loaded?.id ?? null,
      loadedOpportunityId: loaded ? OPP : null,
      boundOpportunityId: OPP,
    });
    if (write.action === "reject") return { rows, result: "error", draftId: null };
    if (write.action === "insert") {
      if (loaded) return { rows, result: "error", draftId: null };
      const id = `draft-${rows.length + 1}`;
      return {
        rows: [...rows, { id, opportunityId: OPP, body }],
        result: "saved",
        draftId: id,
      };
    }
    if (!rows.some((row) => row.id === write.draftId)) {
      return { rows, result: "error", draftId: null };
    }
    return {
      rows: rows.map((row) => (row.id === write.draftId ? { ...row, body } : row)),
      result: "saved",
      draftId: write.draftId,
    };
  }

  it("saves a template onto the opportunity's existing draft", () => {
    const visible = visiblePitchDraft({
      draft: savedDraft,
      fresh: false,
      templateRequested: true,
      suggestion,
    });
    expect(visible.draftId).toBeNull();
    const saved = apply(
      [{ id: savedDraft.id, opportunityId: OPP, body: savedDraft.body }],
      visible.draftId,
      visible.body,
    );
    expect(saved.result).toBe("saved");
    expect(saved.draftId).toBe(savedDraft.id);
    expect(saved.rows).toEqual([{ id: savedDraft.id, opportunityId: OPP, body: suggestion.body }]);
  });

  it("saves a fresh start onto the opportunity's existing draft", () => {
    const visible = visiblePitchDraft({
      draft: savedDraft,
      fresh: true,
      templateRequested: false,
      suggestion,
    });
    expect(visible.draftId).toBeNull();
    const saved = apply(
      [{ id: savedDraft.id, opportunityId: OPP, body: savedDraft.body }],
      visible.draftId,
      "Edited after a fresh start",
    );
    expect(saved.result).toBe("saved");
    expect(saved.draftId).toBe(savedDraft.id);
    expect(saved.rows).toHaveLength(1);
    expect(saved.rows[0]?.body).toBe("Edited after a fresh start");
  });

  it("saves twice without inserting a second draft", () => {
    const first = apply([], null, "First save");
    expect(first.result).toBe("saved");
    const second = apply(first.rows, first.draftId, "Second save");
    expect(second.result).toBe("saved");
    expect(second.draftId).toBe(first.draftId);
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]?.body).toBe("Second save");
    const again = apply(second.rows, null, "Third save with no posted id");
    expect(again.result).toBe("saved");
    expect(again.draftId).toBe(first.draftId);
    expect(again.rows).toHaveLength(1);
  });

  it("lets a save and then an AI draft keep the same row", () => {
    const saved = apply([], null, "Saved by hand");
    const ai = currentDraftWrite({
      draftId: saved.draftId,
      draftOpportunityId: OPP,
      boundOpportunityId: OPP,
    });
    expect(ai).toBe("update");
    const after = apply(saved.rows, null, "AI replacement");
    expect(after.result).toBe("saved");
    expect(after.draftId).toBe(saved.draftId);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.body).toBe("AI replacement");
  });

  it("lets an AI draft and then a save keep the same row", () => {
    expect(
      currentDraftWrite({
        draftId: null,
        draftOpportunityId: null,
        boundOpportunityId: OPP,
      }),
    ).toBe("insert");
    const ai = apply([], null, "AI first");
    expect(
      currentDraftWrite({
        draftId: ai.draftId,
        draftOpportunityId: OPP,
        boundOpportunityId: OPP,
      }),
    ).toBe("update");
    const saved = apply(ai.rows, null, "Saved after AI");
    expect(saved.result).toBe("saved");
    expect(saved.draftId).toBe(ai.draftId);
    expect(saved.rows).toHaveLength(1);
    expect(saved.rows[0]?.body).toBe("Saved after AI");
  });

  it("is the write save uses for a bound draft", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/pitch/actions.ts"), "utf8");
    const save = source.slice(source.indexOf("export async function savePitchDraftAction"));
    expect(save).toContain("resolveOpportunityDraftWrite");
    expect(save).toContain("mayReplaceSavedDraft");
    expect(save).toContain("opportunityNeedsChoice");
    expect(save.indexOf("resolveOpportunityDraftWrite")).toBeLessThan(save.indexOf(".insert("));
    expect(save.indexOf("mayReplaceSavedDraft")).toBeLessThan(save.indexOf(".update("));
    const ai = readFileSync(path.join(process.cwd(), "src/lib/ai/actions.ts"), "utf8");
    expect(ai).toContain("opportunityNeedsChoice");
  });

  it("does not replace a saved draft with an untouched template", () => {
    const saved = { savedSubject: "Saved subject", savedBody: "Saved body" };
    expect(
      mayReplaceSavedDraft({
        hasBoundDraft: true,
        ...saved,
        postedSubject: "Template subject",
        postedBody: "Template body",
        explicitTemplate: false,
        edited: false,
      }),
    ).toEqual({ ok: false, message: UNTOUCHED_DRAFT_MESSAGE });
    expect(
      mayReplaceSavedDraft({
        hasBoundDraft: true,
        ...saved,
        postedSubject: "Template subject",
        postedBody: "Template body",
        explicitTemplate: true,
        edited: false,
      }).ok,
    ).toBe(true);
    expect(
      mayReplaceSavedDraft({
        hasBoundDraft: true,
        ...saved,
        postedSubject: "Saved subject",
        postedBody: "Saved body with an edit",
        explicitTemplate: false,
        edited: true,
      }).ok,
    ).toBe(true);
    expect(
      mayReplaceSavedDraft({
        hasBoundDraft: true,
        ...saved,
        postedSubject: saved.savedSubject,
        postedBody: saved.savedBody,
        explicitTemplate: false,
        edited: false,
      }).ok,
    ).toBe(true);
    expect(
      mayReplaceSavedDraft({
        hasBoundDraft: false,
        ...saved,
        postedSubject: "Template subject",
        postedBody: "Template body",
        explicitTemplate: false,
        edited: false,
      }).ok,
    ).toBe(true);
  });

  it("does not let a selected opportunity change trip into a fresh draft", () => {
    const locked = tripChangeForOpportunity({
      opportunitySelected: true,
      nextTripId: SECOND.tripId,
    });
    expect(locked).toEqual({ kind: "disabled" });
    expect(locked).not.toHaveProperty("fresh");
    expect(
      tripChangeForOpportunity({ opportunitySelected: false, nextTripId: FIRST.tripId }),
    ).toEqual({ kind: "navigate", tripId: FIRST.tripId });
    const composer = readFileSync(
      path.join(process.cwd(), "src/components/pitch/composer.tsx"),
      "utf8",
    );
    expect(composer).toContain("tripChangeForOpportunity");
    expect(composer).toContain("recipientLine");
    expect(composer).toContain("templateIntent");
    expect(composer).not.toContain('params.set("fresh"');
    expect(composer).not.toContain("Hotel recipient will appear after a successful unlock.");
    expect(composer).toContain("disabled={Boolean(pipelineItemId)}");
  });

  it("updates the draft already bound to the opportunity", () => {
    const bound = "22222222-2222-4222-8222-222222222222";
    const other = "33333333-3333-4333-8333-333333333333";
    expect(
      currentDraftWrite({
        draftId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        draftOpportunityId: bound,
        boundOpportunityId: bound,
      }),
    ).toBe("update");
    expect(
      currentDraftWrite({
        draftId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        draftOpportunityId: other,
        boundOpportunityId: bound,
      }),
    ).toBe("insert");
    expect(
      currentDraftWrite({
        draftId: null,
        draftOpportunityId: null,
        boundOpportunityId: bound,
      }),
    ).toBe("insert");
    expect(
      currentDraftWrite({
        draftId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        draftOpportunityId: null,
        boundOpportunityId: null,
      }),
    ).toBe("insert");
  });
});

describe("draft scope and review", () => {
  it("says a picked opportunity keeps its own draft", () => {
    expect(draftScopeNote(2)).toMatch(/does not replace another opportunity/);
    expect(draftScopeNote(1)).toBeNull();
  });

  it("checks the text that is actually there", () => {
    const checks = reviewChecks({
      hotelName: "Siam Canopy House",
      subject: "Hello",
      body: "A short note.",
    });
    expect(checks.find((check) => check.id === "hotel")?.ok).toBe(false);
    expect(checks.find((check) => check.id === "next")?.ok).toBe(false);
    const ready = reviewChecks({
      hotelName: "Siam Canopy House",
      subject: "Siam Canopy House",
      body: "I can share a short film for Siam Canopy House. Would your partnerships team review it? [Your name]",
    });
    expect(ready.find((check) => check.id === "hotel")?.ok).toBe(true);
    expect(ready.find((check) => check.id === "next")?.ok).toBe(true);
    expect(ready.find((check) => check.id === "placeholders")?.ok).toBe(false);
  });
});
