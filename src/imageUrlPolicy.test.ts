import { describe, it, expect } from "vitest";
import { isImageUrlAllowed, parseAllowedImageHosts } from "./imageUrlPolicy";

const R2 = "media.unibooks.example";

describe("isImageUrlAllowed", () => {
  describe("with no allowlist configured (local dev)", () => {
    it("accepts any https host", () => {
      expect(isImageUrlAllowed("https://media.unibooks.example/a.webp", undefined)).toBe(true);
      expect(isImageUrlAllowed("https://anything-at-all.example/a.webp", undefined)).toBe(true);
    });

    it("treats an empty or whitespace-only setting as unset", () => {
      // wrangler hands through an empty string for a declared-but-blank var,
      // which must not read as "an allowlist with nothing on it" — that would
      // reject every image instead of allowing any.
      expect(isImageUrlAllowed("https://x.example/a.webp", "")).toBe(true);
      expect(isImageUrlAllowed("https://x.example/a.webp", "   ")).toBe(true);
      expect(isImageUrlAllowed("https://x.example/a.webp", " , ,")).toBe(true);
    });
  });

  describe("transport", () => {
    it("rejects plain http on a public host", () => {
      // The point of the rule: the recipient's browser must not be made to
      // fetch over a connection anyone on the path can read or rewrite.
      expect(isImageUrlAllowed("http://media.unibooks.example/a.webp", undefined)).toBe(false);
    });

    it("allows http only to localhost, for the dev media server", () => {
      expect(isImageUrlAllowed("http://localhost:8000/media/a.webp", undefined)).toBe(true);
      expect(isImageUrlAllowed("http://127.0.0.1:8000/media/a.webp", undefined)).toBe(true);
    });

    it("does not let a hostname merely containing 'localhost' through", () => {
      // Substring matching here would be an open door: an attacker registers
      // localhost.evil.example and gets the http exemption.
      expect(isImageUrlAllowed("http://localhost.evil.example/a.webp", undefined)).toBe(false);
      expect(isImageUrlAllowed("http://notlocalhost/a.webp", undefined)).toBe(false);
      expect(isImageUrlAllowed("http://127.0.0.1.evil.example/a.webp", undefined)).toBe(false);
    });

    it("rejects non-web schemes outright", () => {
      expect(isImageUrlAllowed("data:image/png;base64,iVBORw0KGgo=", undefined)).toBe(false);
      expect(isImageUrlAllowed("javascript:alert(1)", undefined)).toBe(false);
      expect(isImageUrlAllowed("file:///etc/passwd", undefined)).toBe(false);
      expect(isImageUrlAllowed("ftp://media.unibooks.example/a.webp", undefined)).toBe(false);
    });
  });

  describe("with an allowlist configured (production)", () => {
    it("accepts a host on the list", () => {
      expect(isImageUrlAllowed(`https://${R2}/listings/a.webp`, R2)).toBe(true);
    });

    it("rejects a host that is not on it", () => {
      // The case the setting exists for: a participant pasting a tracking
      // pixel that would harvest the other party's IP and User-Agent.
      expect(isImageUrlAllowed("https://tracker.evil.example/pixel.gif", R2)).toBe(false);
    });

    it("reads a comma-separated list, tolerating whitespace", () => {
      const hosts = ` ${R2} , cdn.unibooks.example `;
      expect(isImageUrlAllowed(`https://${R2}/a.webp`, hosts)).toBe(true);
      expect(isImageUrlAllowed("https://cdn.unibooks.example/a.webp", hosts)).toBe(true);
      expect(isImageUrlAllowed("https://other.example/a.webp", hosts)).toBe(false);
    });

    it("compares hosts case-insensitively, as DNS does", () => {
      expect(isImageUrlAllowed(`https://${R2.toUpperCase()}/a.webp`, R2)).toBe(true);
      expect(isImageUrlAllowed(`https://${R2}/a.webp`, R2.toUpperCase())).toBe(true);
    });

    it("matches the host exactly, not by suffix", () => {
      // Suffix matching would accept media.unibooks.example.evil.example.
      expect(isImageUrlAllowed(`https://${R2}.evil.example/a.webp`, R2)).toBe(false);
      expect(isImageUrlAllowed(`https://evil-${R2}/a.webp`, R2)).toBe(false);
    });

    it("still applies the allowlist to localhost http", () => {
      // The http exemption is about transport, and does not also exempt the
      // host from a configured allowlist.
      expect(isImageUrlAllowed("http://localhost:8000/a.webp", R2)).toBe(false);
    });

    it("ignores credentials, port and path when matching the host", () => {
      expect(isImageUrlAllowed(`https://${R2}:443/deep/path.webp?v=2#x`, R2)).toBe(true);
      // userinfo must not be mistaken for the host: this URL's real host is
      // evil.example, with the allowed name sitting in the username.
      expect(isImageUrlAllowed(`https://${R2}@evil.example/a.webp`, R2)).toBe(false);
    });
  });

  describe("malformed input", () => {
    it("rejects anything that is not a URL", () => {
      expect(isImageUrlAllowed("", undefined)).toBe(false);
      expect(isImageUrlAllowed("not a url", undefined)).toBe(false);
      expect(isImageUrlAllowed("/listings/a.webp", undefined)).toBe(false);
      expect(isImageUrlAllowed("//media.unibooks.example/a.webp", undefined)).toBe(false);
    });
  });
});

describe("parseAllowedImageHosts", () => {
  it("normalizes to a lowercase list, dropping blanks", () => {
    expect(parseAllowedImageHosts(" A.example , ,b.EXAMPLE ")).toEqual(["a.example", "b.example"]);
  });

  it("returns an empty list for unset or blank input", () => {
    expect(parseAllowedImageHosts(undefined)).toEqual([]);
    expect(parseAllowedImageHosts("")).toEqual([]);
    expect(parseAllowedImageHosts(" , ")).toEqual([]);
  });
});
