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

/**
 * Normalize one allowlist entry to a bare hostname.
 *
 * Accepts what Django's R2_PUBLIC_URL holds ("https://media.example.com") as
 * readily as a bare host ("media.example.com"), so the same value can be
 * copied into this setting without being reshaped by hand — the two used to
 * disagree on format, which is the kind of difference that is only discovered
 * when images silently stop sending.
 */
function normalizeHost(entry: string): string | null {
  const trimmed = entry.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    // Parsing both forms through URL also drops a port, a trailing slash and
    // any path, and handles an IPv6 literal's brackets.
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return null;
  }
}

export function parseAllowedImageHosts(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map(normalizeHost)
    .filter((host): host is string => host !== null);
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
