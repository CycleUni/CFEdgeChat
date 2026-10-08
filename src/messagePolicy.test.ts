import { describe, it, expect } from "vitest";
import { isKnownMessageType, metadataError, MAX_METADATA_BYTES } from "./messagePolicy";

describe("isKnownMessageType", () => {
  it("knows text and image only", () => {
    expect(isKnownMessageType("text")).toBe(true);
    expect(isKnownMessageType("image")).toBe(true);
    expect(isKnownMessageType("x")).toBe(false);
    expect(isKnownMessageType(undefined)).toBe(false);
  });
});

describe("metadataError", () => {
  it("accepts no metadata and a file name", () => {
    expect(metadataError(null)).toBeNull();
    expect(metadataError(undefined)).toBeNull();
    expect(metadataError({ filename: "notes.jpg" })).toBeNull();
  });

  it("refuses something that is not an object", () => {
    expect(metadataError("x")).not.toBeNull();
    expect(metadataError([1, 2])).not.toBeNull();
  });

  it("refuses an object past the size cap", () => {
    expect(metadataError({ pad: "a".repeat(MAX_METADATA_BYTES) })).not.toBeNull();
  });
});
