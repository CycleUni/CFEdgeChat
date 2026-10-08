import { describe, it, expect } from "vitest";
import { isSystemMessage } from "./systemMessagePolicy";

describe("isSystemMessage", () => {
  it("catches a control token at the start", () => {
    expect(isSystemMessage("[SYSTEM:order.notify.seller_approved] System Notification")).toBe(true);
    expect(isSystemMessage("[MEETUP_REQUEST]")).toBe(true);
  });

  it("catches a control token in the middle of a message", () => {
    expect(isSystemMessage("ok [SYSTEM:order.notify.seller_approved]")).toBe(true);
    expect(isSystemMessage("see [MEETUP_ACCEPT] above")).toBe(true);
  });

  it("lets ordinary text through, brackets and all", () => {
    expect(isSystemMessage("Is [Chapter 3] included?")).toBe(false);
    expect(isSystemMessage("SYSTEM: not a token")).toBe(false);
  });
});
