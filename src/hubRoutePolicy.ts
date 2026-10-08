/**
 * Whether a request on the public /api/internal/users/<id>/... route may
 * reach that user's hub.
 *
 * Only the snapshot read. The hub's /push and /read are for ChatRoom, which
 * calls them on a direct Durable Object stub and never through this route;
 * forwarding every path here let a user POST /push to their own hub with any
 * recipient, preview and sender, and have it email and push-notify anyone
 * they had chatted with, as often as they liked (a /read clears the
 * once-per-conversation mark).
 */
export function isPublicHubApiRequest(method: string, pathParts: readonly string[]): boolean {
  return method === "GET" && pathParts.length === 5 && pathParts[4] === "snapshot";
}
