/**
 * Which URLs an image message is allowed to point at.
 *
 * An image message is rendered as <img src> in every participant's browser,
 * so its URL is the one piece of user input that makes the other party's
 * browser fetch from an arbitrary server — a tracking pixel harvesting their
 * IP and User-Agent, at minimum. https only (http is allowed for the local
 * dev media server), and when ALLOWED_IMAGE_HOSTS is configured the host must
 * be on it — normally just the R2 public domain the upload endpoints issue.
 *
 * Kept out of ChatRoom so it can be tested as what it is: a pure decision
 * over a string and a setting, with no Durable Object or workerd runtime
 * involved.
 */

/** Hosts http:// is tolerated for, so `wrangler dev` against a local media
 *  server still works. Nothing else may skip TLS. */
const LOCAL_HTTP_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

export function parseAllowedImageHosts(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);
}

export function isImageUrlAllowed(rawUrl: string, allowedImageHosts: string | undefined): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  const isLocalHttp =
    parsed.protocol === "http:" && LOCAL_HTTP_HOSTNAMES.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !isLocalHttp) return false;

  const allowlist = parseAllowedImageHosts(allowedImageHosts);
  // Unset means "any https host": correct for local dev, and the deployment
  // note production is expected to act on. See .dev.vars.example.
  if (allowlist.length === 0) return true;

  return allowlist.includes(parsed.hostname.toLowerCase());
}
