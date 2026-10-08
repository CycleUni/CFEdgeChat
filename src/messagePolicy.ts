// The message types the app renders. Anything else skipped every content
// check on the REST path (the length limit applied to "text" only, the URL
// allowlist to "image" only) and was stored as sent.
export const MESSAGE_TYPES = ["text", "image"] as const;

// What the app attaches today is an image's file name; a stored row is
// otherwise bounded only by the database's 2 MB row limit, and rooms keep
// every row.
export const MAX_METADATA_BYTES = 2048;

export function isKnownMessageType(value: unknown): value is (typeof MESSAGE_TYPES)[number] {
  return typeof value === "string" && (MESSAGE_TYPES as readonly string[]).includes(value);
}

/** Why `metadata` cannot be stored, or null when it can (absent is fine). */
export function metadataError(metadata: unknown): string | null {
  if (metadata === null || metadata === undefined) return null;
  if (typeof metadata !== "object" || Array.isArray(metadata)) return "Metadata must be an object";
  if (new TextEncoder().encode(JSON.stringify(metadata)).length > MAX_METADATA_BYTES) {
    return `Metadata too large (max ${MAX_METADATA_BYTES} bytes)`;
  }
  return null;
}
