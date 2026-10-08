import { describe, it, expect } from "vitest";
import { isPublicHubApiRequest } from "./hubRoutePolicy";

const path = (...rest: string[]) => ["api", "internal", "users", "7", ...rest];

describe("isPublicHubApiRequest", () => {
  it("lets the user read their own snapshot", () => {
    expect(isPublicHubApiRequest("GET", path("snapshot"))).toBe(true);
  });

  it("refuses push, which would email anyone the user has chatted with", () => {
    expect(isPublicHubApiRequest("POST", path("push"))).toBe(false);
  });

  it("refuses read, which clears the once-per-conversation email mark", () => {
    expect(isPublicHubApiRequest("POST", path("read"))).toBe(false);
  });

  it("refuses a path that only ends in snapshot", () => {
    // UserHub dispatches on endsWith, so x/snapshot would still reach it.
    expect(isPublicHubApiRequest("GET", path("x", "snapshot"))).toBe(false);
  });

  it("refuses a snapshot by any other method", () => {
    expect(isPublicHubApiRequest("POST", path("snapshot"))).toBe(false);
  });
});
