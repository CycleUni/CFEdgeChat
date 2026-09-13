import { describe, it, expect } from "vitest";
import { shouldSendOfflineEmail, OfflineEmailInput } from "./offlineEmailPolicy";

const ROOM = "3f0b2a1e-0000-4000-8000-000000000001";

function input(overrides: Partial<OfflineEmailInput> = {}): OfflineEmailInput {
  return {
    roomId: ROOM,
    isSelf: false,
    activeSocketCount: 0,
    notifiedRooms: [],
    ...overrides,
  };
}

describe("shouldSendOfflineEmail", () => {
  it("notifies a recipient who has no connection to the chat service", () => {
    expect(shouldSendOfflineEmail(input())).toBe(true);
  });

  it("stays silent while the recipient has the site open", () => {
    // The unread badge is the notification in that case — the requirement is
    // to mail people who are *away*, not people whose chat panel is closed.
    expect(shouldSendOfflineEmail(input({ activeSocketCount: 1 }))).toBe(false);
  });

  it("stays silent when only one of several devices is connected", () => {
    expect(shouldSendOfflineEmail(input({ activeSocketCount: 3 }))).toBe(false);
  });

  it("never notifies the sender about their own message", () => {
    // ChatRoom pushes to the sender's hub too, so their inbox preview updates.
    expect(shouldSendOfflineEmail(input({ isSelf: true }))).toBe(false);
    // Even offline: sending a message from another device is not news.
    expect(shouldSendOfflineEmail(input({ isSelf: true, activeSocketCount: 0 }))).toBe(false);
  });

  it("sends only once per conversation until it is opened", () => {
    // The second and third message of a burst must not each become an email.
    expect(shouldSendOfflineEmail(input({ notifiedRooms: [ROOM] }))).toBe(false);
  });

  it("still notifies about a different conversation", () => {
    // The one-email rule is per conversation, not per user: a message from
    // someone else, about another listing, is genuinely new information.
    expect(shouldSendOfflineEmail(input({ notifiedRooms: ["some-other-room"] }))).toBe(true);
  });

  it("notifies again once the conversation has been opened", () => {
    // Opening the room clears it from notifiedRooms (UserHub.markRead), which
    // is the whole state this rule reads.
    expect(shouldSendOfflineEmail(input({ notifiedRooms: [] }))).toBe(true);
  });

  it("does nothing without a room to notify about", () => {
    expect(shouldSendOfflineEmail(input({ roomId: undefined }))).toBe(false);
    expect(shouldSendOfflineEmail(input({ roomId: "" }))).toBe(false);
  });
});
