import { describe, it, expect } from "vitest";
import { mayMarkRead } from "./markReadPolicy";

describe("mayMarkRead", () => {
  it("lets ordinary participants mark a room read", () => {
    expect(mayMarkRead("user", "7", ["7", "9"])).toBe(true);
  });

  it("lets a read-only participant mark a room read", () => {
    // The chat of a deleted listing: both sides get an observer token.
    expect(mayMarkRead("observer", "7", ["7", "9"])).toBe(true);
  });

  it("does not let a moderator mark a room they only observe", () => {
    expect(mayMarkRead("observer", "1", ["7", "9"])).toBe(false);
  });

  it("refuses an observer when the room has no participant list", () => {
    expect(mayMarkRead("observer", "7", undefined)).toBe(false);
  });
});
