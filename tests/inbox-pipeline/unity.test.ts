import { describe, expect, it } from "vitest";

import { parseInboxUnity } from "@/lib/inbox-pipeline/contract";
import { INBOX_COPY, inboxPanelModel } from "@/lib/inbox-pipeline/display";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    result: "ok",
    pipeline_status: "pitched",
    unity: "creator_authoritative",
    binding: {
      mail_account_id: "00000000-0000-4000-8000-000000000001",
      provider_thread_id: "thread-1",
      email_address: "creator@example.invalid",
    },
    reading: {
      commercial_state: "negotiating",
      stale: false,
      has_redirect: false,
      has_rejection: false,
      has_human_reply: true,
      decline_supported: false,
    },
    suggestions: [],
    ...overrides,
  };
}

describe("inbox unity parse", () => {
  it("keeps a shared word on two fields", () => {
    const unity = parseInboxUnity(payload());
    expect(unity?.pipelineStatus).toBe("pitched");
    expect(unity?.reading?.commercialState).toBe("negotiating");
    expect(inboxPanelModel(unity!).title).toBe(INBOX_COPY.sectionTitle);
    expect(inboxPanelModel(unity!).pipelineLabel).toBe("Sent");
  });

  it("rejects a machine label stored as the pipeline status", () => {
    expect(parseInboxUnity(payload({ pipeline_status: "agreement_observed" }))).toBeNull();
    expect(parseInboxUnity(payload({ pipeline_status: "declined_observed" }))).toBeNull();
    expect(parseInboxUnity(payload({ pipeline_status: "redirect" }))).toBeNull();
  });

  it("rejects a decline suggestion that would apply CRM or that cites a redirect", () => {
    expect(
      parseInboxUnity(
        payload({
          unity: "suggestion_pending",
          reading: {
            commercial_state: "declined_observed",
            stale: false,
            has_redirect: true,
            has_rejection: false,
            has_human_reply: true,
            decline_supported: true,
          },
          suggestions: [
            {
              id: "00000000-0000-4000-8000-000000000002",
              kind: "review_decline",
              status: "pending",
              applies_crm: false,
              basis: "rejection",
            },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      parseInboxUnity(
        payload({
          unity: "suggestion_pending",
          suggestions: [
            {
              id: "00000000-0000-4000-8000-000000000002",
              kind: "review_decline",
              status: "pending",
              applies_crm: true,
              basis: "rejection",
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("treats a failed payload as unreadable, not as unlinked", () => {
    expect(parseInboxUnity({ result: "not_found" })).toBeNull();
    expect(parseInboxUnity(null)).toBeNull();
  });
});

describe("inbox panel copy", () => {
  it("says a redirect is not a rejection and does not retitle the pipeline", () => {
    const unity = parseInboxUnity(
      payload({
        unity: "suggestion_pending",
        reading: {
          commercial_state: "unresolved",
          stale: false,
          has_redirect: true,
          has_rejection: false,
          has_human_reply: true,
          decline_supported: false,
        },
        suggestions: [
          {
            id: "00000000-0000-4000-8000-000000000003",
            kind: "mark_replied",
            status: "pending",
            applies_crm: true,
            basis: "human_reply",
          },
        ],
      }),
    );
    const model = inboxPanelModel(unity!);
    expect(model.pipelineLabel).toBe("Sent");
    expect(model.title).not.toMatch(/reject/i);
    expect(model.notices).toContain(INBOX_COPY.redirectNotice);
    expect(model.body).toMatch(/does not change/);
  });

  it("says an agreement reading is not a won deal", () => {
    const unity = parseInboxUnity(
      payload({
        pipeline_status: "replied",
        reading: {
          commercial_state: "agreement_observed",
          stale: false,
          has_redirect: false,
          has_rejection: false,
          has_human_reply: true,
          decline_supported: false,
        },
      }),
    );
    const model = inboxPanelModel(unity!);
    expect(model.pipelineLabel).toBe("Replied");
    expect(model.notices).toContain(INBOX_COPY.agreementNotice);
    expect(model.notices.join(" ")).not.toMatch(/won deal was recorded|status is won/i);
  });

  it("says acknowledging a rejection does not close the cycle", () => {
    const unity = parseInboxUnity(
      payload({
        unity: "suggestion_pending",
        pipeline_status: "negotiating",
        reading: {
          commercial_state: "declined_observed",
          stale: false,
          has_redirect: false,
          has_rejection: true,
          has_human_reply: true,
          decline_supported: true,
        },
        suggestions: [
          {
            id: "00000000-0000-4000-8000-000000000004",
            kind: "review_decline",
            status: "pending",
            applies_crm: false,
            basis: "rejection",
          },
        ],
      }),
    );
    expect(inboxPanelModel(unity!).notices).toContain(INBOX_COPY.declineNotice);
    expect(inboxPanelModel(unity!).pipelineLabel).toBe("Negotiating");
  });
});
