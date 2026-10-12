/**
 * Inbox and collaboration lists: empty, error, and truncation stay distinct,
 * and User B's hotel, email, and compensation never become User A's copy.
 */
import { describe, expect, it } from "vitest";

import {
  COLLABORATION_LIST_COLUMNS,
  GMAIL_PROBE_COLUMNS,
  INBOX_LIST_COLUMNS,
  collaborationListState,
  inboxListState,
} from "@/lib/surfaces/lists";

const PROFILE_A = "99999999-9999-9999-9999-999999999999";
const PROFILE_B = "88888888-8888-8888-8888-888888888888";
const AUTH_A = "11111111-1111-1111-1111-111111111111";
const AUTH_B = "22222222-2222-2222-2222-222222222222";
const HOTEL_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const HOTEL_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ROW_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const ROW_B = "dddddddd-dddd-dddd-dddd-dddddddddddd";

describe("list column contracts", () => {
  it("does not select compensation, message bodies, thread ids, or credentials", () => {
    const selected = `${COLLABORATION_LIST_COLUMNS} ${INBOX_LIST_COLUMNS} ${GMAIL_PROBE_COLUMNS}`;
    expect(selected).not.toMatch(
      /private_value|compensation|snippet|raw_|body|provider_thread_id|refresh|access_token|credential/i,
    );
  });
});

describe("collaboration list", () => {
  const own = {
    id: ROW_A,
    creator_id: PROFILE_A,
    hotel_id: HOTEL_A,
    status: "active",
    collaboration_type: "stay",
    start_date: "2026-11-01",
    end_date: "2026-11-04",
    private_value_amount: 99999,
    hotel: { id: HOTEL_A, name: "Ada Hotel" },
  };
  const foreign = {
    id: ROW_B,
    creator_id: PROFILE_B,
    hotel_id: HOTEL_B,
    status: "secret_internal",
    collaboration_type: "private_value_amount",
    hotel: { id: HOTEL_B, name: "Secret Villa" },
    private_value_amount: 42,
  };

  it("drops User B and does not render compensation or an unknown status string", () => {
    const state = collaborationListState({
      failed: false,
      identityFailed: false,
      total: 2,
      rawRows: [foreign, own],
      viewerId: PROFILE_A,
    });
    expect(state.kind).toBe("items");
    if (state.kind !== "items") return;
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.hotelName).toBe("Ada Hotel");
    expect(state.items[0]?.statusLabel).toBe("Collaboration active");
    expect(state.summary).toBe("1 collaboration.");
    const packed = JSON.stringify(state);
    expect(packed).not.toContain("Secret Villa");
    expect(packed).not.toContain("secret_internal");
    expect(packed).not.toContain("99999");
    expect(packed).not.toContain("private_value");
  });

  it("an only-foreign payload is an empty list for A, not B's hotel", () => {
    const state = collaborationListState({
      failed: false,
      identityFailed: false,
      total: 4,
      rawRows: [foreign],
      viewerId: PROFILE_A,
    });
    expect(state.kind).toBe("empty");
    expect(JSON.stringify(state)).not.toContain("Secret Villa");
  });

  it("a failed read and a count that disagrees with an empty page are not empty", () => {
    const failed = collaborationListState({
      failed: true,
      identityFailed: false,
      total: 0,
      rawRows: [],
      viewerId: PROFILE_A,
    });
    expect(failed.kind).toBe("error");
    if (failed.kind !== "error") return;
    expect(failed.body).toContain("not an empty list");

    const disagree = collaborationListState({
      failed: false,
      identityFailed: false,
      total: 3,
      rawRows: [],
      viewerId: PROFILE_A,
    });
    expect(disagree.kind).toBe("error");

    const missingIdentity = collaborationListState({
      failed: false,
      identityFailed: true,
      total: 1,
      rawRows: [foreign],
      viewerId: null,
    });
    expect(missingIdentity.kind).toBe("error");
    expect(JSON.stringify(missingIdentity)).not.toContain("Secret Villa");
  });

  it("states a cap instead of pretending the page is the whole list", () => {
    const state = collaborationListState({
      failed: false,
      identityFailed: false,
      total: 51,
      rawRows: [own],
      viewerId: PROFILE_A,
    });
    expect(state.kind).toBe("items");
    if (state.kind !== "items") return;
    expect(state.summary).toBe("Showing 1 of 51 collaborations.");
  });

  it("an unreadable row fails the page rather than becoming a blank collaboration", () => {
    const state = collaborationListState({
      failed: false,
      identityFailed: false,
      total: 1,
      rawRows: [{ creator_id: PROFILE_A, hotel: { name: "Ada Hotel" } }],
      viewerId: PROFILE_A,
    });
    expect(state.kind).toBe("error");
    expect(JSON.stringify(state)).not.toContain("Ada Hotel");
  });
});

describe("inbox list", () => {
  const own = {
    id: ROW_A,
    creator_id: PROFILE_A,
    pipeline_item_id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
    pipeline_item: { hotel_id: HOTEL_A, hotel: { id: HOTEL_A, name: "Ada Hotel" } },
    mail_account: { email_address: "ada@example.com", user_id: AUTH_A },
  };
  const foreign = {
    id: ROW_B,
    creator_id: PROFILE_B,
    pipeline_item: { hotel_id: HOTEL_B, hotel: { id: HOTEL_B, name: "Secret Villa" } },
    mail_account: { email_address: "bee-secret@example.com", user_id: AUTH_B },
  };

  it("links A's hotel and hides B's mailbox when the binding is A's but the address is not", () => {
    const state = inboxListState({
      failed: false,
      identityFailed: false,
      total: 1,
      rawRows: [
        {
          ...own,
          mail_account: { email_address: "bee-secret@example.com", user_id: AUTH_B },
        },
      ],
      viewerId: PROFILE_A,
      authUserId: AUTH_A,
      mailbox: "connected",
    });
    expect(state.kind).toBe("items");
    if (state.kind !== "items") return;
    expect(state.items[0]?.hotelName).toBe("Ada Hotel");
    expect(state.items[0]?.email).toBeNull();
    expect(JSON.stringify(state)).not.toContain("bee-secret@example.com");
  });

  it("does not list User B's thread", () => {
    const state = inboxListState({
      failed: false,
      identityFailed: false,
      total: 2,
      rawRows: [foreign, own],
      viewerId: PROFILE_A,
      authUserId: AUTH_A,
      mailbox: "connected",
    });
    expect(state.kind).toBe("items");
    const packed = JSON.stringify(state);
    expect(packed).toContain("Ada Hotel");
    expect(packed).toContain("ada@example.com");
    expect(packed).not.toContain("Secret Villa");
    expect(packed).not.toContain("bee-secret@example.com");
  });

  it("a failed mailbox probe with no links is an error, not a connect prompt", () => {
    const state = inboxListState({
      failed: false,
      identityFailed: false,
      total: 0,
      rawRows: [],
      viewerId: PROFILE_A,
      authUserId: AUTH_A,
      mailbox: "error",
    });
    expect(state.kind).toBe("error");
    expect(JSON.stringify(state)).not.toContain("Connect Gmail");
  });

  it("still shows links when the mailbox probe fails but the bindings loaded", () => {
    const state = inboxListState({
      failed: false,
      identityFailed: false,
      total: 1,
      rawRows: [own],
      viewerId: PROFILE_A,
      authUserId: AUTH_A,
      mailbox: "error",
    });
    expect(state.kind).toBe("items");
  });

  it("points an empty connected inbox at the pipeline, and an absent mailbox at the account page", () => {
    const absent = inboxListState({
      failed: false,
      identityFailed: false,
      total: 0,
      rawRows: [],
      viewerId: PROFILE_A,
      authUserId: AUTH_A,
      mailbox: "absent",
    });
    expect(absent.kind).toBe("empty");
    if (absent.kind !== "empty") return;
    expect(absent.cta?.href).toBe("/app/account");
    expect(JSON.stringify(absent)).not.toContain("/api/integrations/gmail");

    const unconfigured = inboxListState({
      failed: false,
      identityFailed: false,
      total: 0,
      rawRows: [],
      viewerId: PROFILE_A,
      authUserId: AUTH_A,
      mailbox: "unconfigured",
    });
    expect(unconfigured.kind).toBe("empty");
    if (unconfigured.kind !== "empty") return;
    expect(unconfigured.cta).toBeNull();
    expect(unconfigured.body).toContain("not configured");
  });
});
