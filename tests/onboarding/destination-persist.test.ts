/**
 * Choosing a destination chip writes creator_onboarding_state before the
 * creator leaves the page. The creator id is the session profile. A catalog
 * miss does not write. The optional pitch is unrelated.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({
  resolveSession: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

import { resolveSession } from "@/lib/auth/guards";
import {
  chooseOnboardingDestination,
  rememberOnboardingDestination,
} from "@/lib/onboarding/actions";
import {
  createDestinationSaveQueue,
  shouldPersistDestinationBeforeLeave,
} from "@/lib/onboarding/destination";
import { createClient } from "@/lib/supabase/server";

const AUTH_A = "11111111-1111-4111-8111-111111111111";
const PROFILE_A = "99999999-9999-4999-8999-999999999999";
const PROFILE_B = "88888888-8888-4888-8888-888888888888";
const BALI = "33333333-3333-4333-8333-333333333333";

type Row = { data: unknown; error: { message: string } | null };

function mockClient(input: { profile?: Row; destination?: Row; upsertError?: string | null }) {
  const upserts: { table: string; payload: unknown }[] = [];
  const filters: { table: string; column: string; value: string }[] = [];
  vi.mocked(createClient).mockResolvedValue({
    from(table: string) {
      const chain = {
        select() {
          return chain;
        },
        eq(column: string, value: string) {
          filters.push({ table, column, value });
          return chain;
        },
        maybeSingle: async () => {
          if (table === "creator_profiles") return input.profile ?? { data: null, error: null };
          if (table === "destinations") return input.destination ?? { data: null, error: null };
          return { data: null, error: { message: "unexpected" } };
        },
        upsert: async (payload: unknown) => {
          upserts.push({ table, payload });
          return { error: input.upsertError ? { message: input.upsertError } : null };
        },
      };
      return chain;
    },
  } as never);
  return { upserts, filters };
}

describe("destination persistence", () => {
  beforeEach(() => {
    vi.mocked(resolveSession).mockReset();
    vi.mocked(createClient).mockReset();
  });

  it("does not navigate away from a selected chip without a write", () => {
    const source = readFileSync(
      path.join(__dirname, "../../src/components/onboarding/destination-question.tsx"),
      "utf8",
    );
    expect(source).toContain("rememberOnboardingDestination");
    expect(source).toContain("shouldPersistDestinationBeforeLeave");
    expect(source).toContain("Back to home");
    expect(shouldPersistDestinationBeforeLeave("")).toBe(false);
    expect(shouldPersistDestinationBeforeLeave("bali")).toBe(false);
    expect(shouldPersistDestinationBeforeLeave(BALI)).toBe(true);
    expect(shouldPersistDestinationBeforeLeave(PROFILE_B)).toBe(true);
  });

  it("writes the session profile, not a caller-supplied creator, and skips a missing catalog row", async () => {
    vi.mocked(resolveSession).mockResolvedValue({
      status: "authenticated",
      session: { userId: AUTH_A, email: "ada@example.test", role: "creator" },
    });
    const missing = mockClient({
      profile: { data: { id: PROFILE_A }, error: null },
      destination: { data: null, error: null },
    });
    const missed = await rememberOnboardingDestination(BALI);
    expect(missed).toEqual({ error: "That destination is not in our catalog." });
    expect(missing.upserts).toEqual([]);
    expect(JSON.stringify(missed)).not.toContain("postgres");

    const saved = mockClient({
      profile: { data: { id: PROFILE_A }, error: null },
      destination: { data: { id: BALI }, error: null },
    });
    const ok = await rememberOnboardingDestination(BALI);
    expect(ok).toEqual({ ok: true });
    expect(saved.filters).toContainEqual({
      table: "creator_profiles",
      column: "user_id",
      value: AUTH_A,
    });
    expect(saved.upserts).toEqual([
      {
        table: "creator_onboarding_state",
        payload: { creator_id: PROFILE_A, destination_id: BALI },
      },
    ]);
    expect(JSON.stringify(saved.upserts)).not.toContain(PROFILE_B);
  });

  it("refuses a non-uuid and an anonymous session without writing", async () => {
    const client = mockClient({});
    expect(await rememberOnboardingDestination("bali")).toEqual({
      error: "Choose a destination from the list.",
    });
    expect(createClient).not.toHaveBeenCalled();

    vi.mocked(resolveSession).mockResolvedValue({ status: "anonymous" });
    expect(await rememberOnboardingDestination(BALI)).toEqual({ error: "You need to sign in." });
    expect(client.upserts).toEqual([]);
  });

  it("hides a database error and still redirects to hotels after a successful choice", async () => {
    vi.mocked(resolveSession).mockResolvedValue({
      status: "authenticated",
      session: { userId: AUTH_A, email: null, role: "creator" },
    });
    mockClient({
      profile: { data: { id: PROFILE_A }, error: null },
      destination: { data: { id: BALI }, error: null },
      upsertError: "duplicate key value violates creator_id secret@hotel.test",
    });
    const failed = await rememberOnboardingDestination(BALI);
    expect(failed).toEqual({ error: "We could not save the destination. Try again." });
    expect(JSON.stringify(failed)).not.toContain("secret@hotel.test");

    mockClient({
      profile: { data: { id: PROFILE_A }, error: null },
      destination: { data: { id: BALI }, error: null },
    });
    const form = new FormData();
    form.set("destinationId", BALI);
    await expect(chooseOnboardingDestination(null, form)).rejects.toThrow(
      "REDIRECT:/app/onboarding/hotels",
    );
  });

  it("keeps the last chip when an older save has not started", async () => {
    const skipped: string[] = [];
    const fresh = createDestinationSaveQueue(async (id) => {
      skipped.push(id);
      return { ok: true };
    });
    const older = fresh.enqueue("A");
    const newer = fresh.enqueue("B");
    await older;
    await newer;
    expect(skipped).toEqual(["B"]);
  });

  it("finishes a save that already started, then writes the newer chip", async () => {
    const writes: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = createDestinationSaveQueue(async (id) => {
      writes.push(id);
      if (id === "A") await gate;
      return { ok: true };
    });
    const first = queue.enqueue("A");
    await Promise.resolve();
    expect(writes).toEqual(["A"]);
    const second = queue.enqueue("B");
    release();
    await first;
    await second;
    expect(writes).toEqual(["A", "B"]);
  });
});
