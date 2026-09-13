/**
 * Which URLs this Worker is willing to call back into Django on.
 *
 * DJANGO_WEBHOOK_URL is operator-set config, not attacker-controlled input,
 * but a typo'd or stale value would otherwise turn every message into an
 * outbound request to wherever that value happens to point — so only https,
 * or http to localhost for `wrangler dev` against a local Django.
 *
 * Shared by ChatRoom (inbox-preview mirror) and UserHub (offline email
 * notification), which both read the same variable: a guard that only one of
 * them applied would be a guard the other quietly skipped.
 */

/** Hosts http:// is tolerated for, so local dev works without TLS. */
const LOCAL_HTTP_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

export function isWebhookUrlAllowed(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && LOCAL_HTTP_HOSTNAMES.has(parsed.hostname);
}
