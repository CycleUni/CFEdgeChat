import { describe, expect, it } from "vitest";
import { completeClose } from "./wsClose";

function fakeSocket(throws = false) {
  const calls: Array<[number, string]> = [];
  const ws = {
    close(code: number, reason: string) {
      if (throws) throw new Error("already closed");
      calls.push([code, reason]);
    },
  } as unknown as WebSocket;
  return { ws, calls };
}

describe("completeClose", () => {
  it("echoes a sendable close code and reason back", () => {
    const { ws, calls } = fakeSocket();
    completeClose(ws, 1001, "going away");
    expect(calls).toEqual([[1001, "going away"]]);
  });

  it.each([1005, 1006])("answers the observed-only code %i with 1000", (code) => {
    const { ws, calls } = fakeSocket();
    completeClose(ws, code, "");
    expect(calls).toEqual([[1000, ""]]);
  });

  it("swallows the error from a socket that is already closed", () => {
    const { ws } = fakeSocket(true);
    expect(() => completeClose(ws, 1000, "")).not.toThrow();
  });
});
