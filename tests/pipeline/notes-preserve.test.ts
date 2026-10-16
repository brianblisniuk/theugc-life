/**
 * An empty notes save must not erase a note the editor never loaded.
 * A clear is a separate, explicit signal.
 */
import { describe, expect, it } from "vitest";

import { notesWritePlan } from "@/lib/pipeline/notes";

describe("private notes write plan", () => {
  it("keeps the stored note when the submitted text is empty and not cleared", () => {
    expect(notesWritePlan("", false)).toEqual({ action: "preserve" });
    expect(notesWritePlan("   ", false)).toEqual({ action: "preserve" });
    expect(notesWritePlan("\n", false).action).not.toBe("write");
  });

  it("writes a clear only when the creator emptied the loaded note", () => {
    expect(notesWritePlan("", true)).toEqual({ action: "write", notes: "" });
    expect(notesWritePlan("  kept  ", false)).toEqual({ action: "write", notes: "kept" });
    expect(notesWritePlan("  kept  ", true)).toEqual({ action: "write", notes: "kept" });
  });

  it("rejects a note that is too long before it can replace the stored one", () => {
    expect(notesWritePlan("x".repeat(8001), true)).toEqual({ action: "invalid" });
  });
});
